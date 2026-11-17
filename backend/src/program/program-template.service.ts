import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateProgramTemplateOrigins } from '../config/runtime-secret-contract';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

export const PROGRAM_TEMPLATE_KIND = 'alcantara.program-template';
export const PROGRAM_TEMPLATE_CONTRACT_VERSION = 1;
export const PROGRAM_TEMPLATE_CONTRACT_VERSION_V2 = 2;
export const PROGRAM_TEMPLATE_PROTOCOL = 'alcantara.program.v1';
export const PROGRAM_TEMPLATE_PROTOCOL_V2 = 'alcantara.program.v2';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MANIFEST_TIMEOUT_MS = 5_000;
export const DEFAULT_PRODUCTION_TEMPLATE_ORIGINS = Object.freeze([
  'https://cdn.fifthbell.com',
]);
const TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PARAMETER_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const SIGNAL_PATTERN = /^[a-z][a-z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const PROGRAM_TEMPLATE_SIGNALS = new Set([
  'audio_bus_update',
  'broadcast_settings_update',
  'heartbeat',
  'instant_play',
  'instant_stop_all',
  'program_media_groups_changed',
  'program_reload',
  'program_scenes_changed',
  'program_state_snapshot',
  'program_stingers_changed',
  'scene_change',
  'scene_cleared',
  'scene_instant_state',
  'scene_instant_stop',
  'scene_instant_take',
  'scene_staged',
  'scene_update',
  'song_off_air',
]);

export const V2_ONLY_SIGNALS = new Set([
  'chyron_update',
  'fade_to_black',
  'song_playback_active',
  'song_playback_update',
  'song_queue_update',
  'audio_levels',
  'audience_interaction_draw_start',
  'audience_interaction_draw_end',
]);

export const PROGRAM_TEMPLATE_V2_SIGNALS = new Set([
  ...PROGRAM_TEMPLATE_SIGNALS,
  ...V2_ONLY_SIGNALS,
]);

export const PROGRAM_TEMPLATE_V2_CAPABILITIES = new Set([
  'audio.playback',
  'media.groups',
  'scene.configuration',
  'stinger.transitions',
  'audience.interaction',
  'data.chart-provider',
  'source.external-video',
  'source.webrtc-guest',
  'sequence.song',
  'sequence.chyron',
  'media.slideshow',
  'display.clock',
  'display.ticker',
  'display.scoreboard',
]);

export interface ProgramTemplateManifestFile {
  key: string;
  bytes: number;
  contentType: string;
  sha256: string;
}

export interface ProgramTemplateManifest {
  kind: typeof PROGRAM_TEMPLATE_KIND;
  contractVersion: 1 | 2;
  id: string;
  name: string;
  package: string;
  bundleVersion: string;
  schemaVersion: number;
  entrypoint: string;
  entrypointUrl: string;
  capabilities: string[];
  control: {
    protocol:
      | typeof PROGRAM_TEMPLATE_PROTOCOL
      | typeof PROGRAM_TEMPLATE_PROTOCOL_V2;
    transport: 'server-sent-events';
    snapshotPath: string;
    eventsPath: string;
    runtimeParameters: {
      programId: string;
      apiBaseUrl: string;
    };
    signals: string[];
  };
  files?: ProgramTemplateManifestFile[];
}

export function getApprovedTemplateOrigins(
  environment: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set([
    ...DEFAULT_PRODUCTION_TEMPLATE_ORIGINS,
    ...validateProgramTemplateOrigins(
      environment.PROGRAM_TEMPLATE_ORIGINS ?? '',
    ),
  ]);
}

/** Program state schema version emitted to a registration: 2 for contract v2, else 1. */
export function programTemplateSchemaVersion(
  manifest: Pick<ProgramTemplateManifest, 'contractVersion'>,
): 1 | 2 {
  return manifest.contractVersion === PROGRAM_TEMPLATE_CONTRACT_VERSION_V2
    ? 2
    : 1;
}

export interface ProgramTemplateRegistration {
  templateUrl: string;
  templateManifest: ProgramTemplateManifest;
  templateVerifiedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`Template manifest ${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > 200 || (pattern && !pattern.test(normalized))) {
    throw new BadRequestException(`Template manifest ${field} is invalid`);
  }
  return normalized;
}

function uniqueStringList(
  value: unknown,
  field: string,
  pattern: RegExp,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new BadRequestException(
      `Template manifest ${field} must be a non-empty array`,
    );
  }
  const normalized = value.map((entry) =>
    requiredString(entry, field, pattern),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new BadRequestException(
      `Template manifest ${field} contains duplicates`,
    );
  }
  return normalized;
}

function safeRelativePath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new BadRequestException(`Template manifest ${field} is invalid`);
  }
  return path;
}

async function readBoundedManifestBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new BadRequestException('Template manifest is too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
}

export function validateProgramTemplateManifest(
  value: unknown,
  manifestUrl: URL,
): ProgramTemplateManifest {
  if (!isRecord(value)) {
    throw new BadRequestException('Template manifest must be a JSON object');
  }
  if (value.kind !== PROGRAM_TEMPLATE_KIND) {
    throw new BadRequestException(
      `Template manifest kind must be ${PROGRAM_TEMPLATE_KIND}`,
    );
  }
  if (
    value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION &&
    value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION_V2
  ) {
    throw new BadRequestException(
      `Unsupported template contract version ${String(value.contractVersion)}`,
    );
  }
  const isV2 = value.contractVersion === PROGRAM_TEMPLATE_CONTRACT_VERSION_V2;
  const expectedSchemaVersion = isV2 ? 2 : 1;
  if (value.schemaVersion !== expectedSchemaVersion) {
    throw new BadRequestException(
      `Unsupported program state schema version ${String(value.schemaVersion)}`,
    );
  }

  const entrypoint = safeRelativePath(value.entrypoint, 'entrypoint');
  const entrypointUrl = new URL(entrypoint, manifestUrl);
  if (entrypointUrl.origin !== manifestUrl.origin) {
    throw new BadRequestException(
      'Template manifest entrypoint must remain on the manifest origin',
    );
  }
  const capabilities = uniqueStringList(
    value.capabilities,
    'capabilities',
    TOKEN_PATTERN,
    64,
  );
  if (isV2) {
    const unsupportedCapability = capabilities.find(
      (capability) => !PROGRAM_TEMPLATE_V2_CAPABILITIES.has(capability),
    );
    if (unsupportedCapability) {
      throw new BadRequestException(
        `Template manifest requests unsupported capability ${unsupportedCapability}`,
      );
    }
  }

  if (!isRecord(value.control)) {
    throw new BadRequestException('Template manifest control is required');
  }
  const expectedProtocol = isV2
    ? PROGRAM_TEMPLATE_PROTOCOL_V2
    : PROGRAM_TEMPLATE_PROTOCOL;
  if (value.control.protocol !== expectedProtocol) {
    throw new BadRequestException(
      `Template manifest control protocol must be ${expectedProtocol}`,
    );
  }
  if (value.control.transport !== 'server-sent-events') {
    throw new BadRequestException(
      'Template manifest control transport must be server-sent-events',
    );
  }
  if (!isRecord(value.control.runtimeParameters)) {
    throw new BadRequestException(
      'Template manifest control.runtimeParameters is required',
    );
  }
  const snapshotPath = safeRelativePath(
    value.control.snapshotPath,
    'control.snapshotPath',
  );
  const eventsPath = safeRelativePath(
    value.control.eventsPath,
    'control.eventsPath',
  );
  if (snapshotPath !== 'state' || eventsPath !== 'events') {
    throw new BadRequestException(
      'Template manifest control paths are unsupported',
    );
  }
  const signals = uniqueStringList(
    value.control.signals,
    'control.signals',
    SIGNAL_PATTERN,
    64,
  );
  const allowedSignals = isV2
    ? PROGRAM_TEMPLATE_V2_SIGNALS
    : PROGRAM_TEMPLATE_SIGNALS;
  const unsupportedSignal = signals.find(
    (signal) => !allowedSignals.has(signal),
  );
  if (unsupportedSignal) {
    throw new BadRequestException(
      `Template manifest requests unsupported signal ${unsupportedSignal}`,
    );
  }
  if (!signals.includes('program_state_snapshot')) {
    throw new BadRequestException(
      'Template manifest must accept program_state_snapshot',
    );
  }

  let files: ProgramTemplateManifestFile[] | undefined;
  if (isV2) {
    const allowedTopLevel = new Set([
      'kind',
      'contractVersion',
      'schemaVersion',
      'id',
      'name',
      'package',
      'bundleVersion',
      'entrypoint',
      'capabilities',
      'control',
      'files',
    ]);
    const extraKey = Object.keys(value).find(
      (key) => !allowedTopLevel.has(key),
    );
    if (extraKey) {
      throw new BadRequestException(
        `Template manifest contains unrecognized property ${extraKey}`,
      );
    }
    const allowedControl = new Set([
      'protocol',
      'transport',
      'snapshotPath',
      'eventsPath',
      'runtimeParameters',
      'signals',
    ]);
    const extraControlKey = Object.keys(value.control).find(
      (key) => !allowedControl.has(key),
    );
    if (extraControlKey) {
      throw new BadRequestException(
        `Template manifest control contains unrecognized property ${extraControlKey}`,
      );
    }
    const allowedRuntime = new Set(['programId', 'apiBaseUrl']);
    const extraRuntimeKey = Object.keys(value.control.runtimeParameters).find(
      (key) => !allowedRuntime.has(key),
    );
    if (extraRuntimeKey) {
      throw new BadRequestException(
        `Template manifest control.runtimeParameters contains unrecognized property ${extraRuntimeKey}`,
      );
    }

    if (value.files !== undefined) {
      if (!Array.isArray(value.files)) {
        throw new BadRequestException(
          'Template manifest files must be an array',
        );
      }
      files = value.files.map((fileEntry, index) => {
        if (!isRecord(fileEntry)) {
          throw new BadRequestException(
            `Template manifest file at index ${index} must be an object`,
          );
        }
        const key = requiredString(fileEntry.key, `files[${index}].key`);
        if (
          typeof fileEntry.bytes !== 'number' ||
          !Number.isInteger(fileEntry.bytes) ||
          fileEntry.bytes < 0
        ) {
          throw new BadRequestException(
            `Template manifest file at index ${index} bytes is invalid`,
          );
        }
        const contentType = requiredString(
          fileEntry.contentType,
          `files[${index}].contentType`,
        );
        if (
          typeof fileEntry.sha256 !== 'string' ||
          !SHA256_PATTERN.test(fileEntry.sha256)
        ) {
          throw new BadRequestException(
            `Template manifest file at index ${index} sha256 is invalid`,
          );
        }
        return {
          key,
          bytes: fileEntry.bytes,
          contentType,
          sha256: fileEntry.sha256,
        };
      });
    }
  }

  const manifest: ProgramTemplateManifest = {
    kind: PROGRAM_TEMPLATE_KIND,
    contractVersion: isV2 ? 2 : 1,
    id: requiredString(value.id, 'id', TOKEN_PATTERN),
    name: requiredString(value.name, 'name'),
    package: requiredString(value.package, 'package'),
    bundleVersion: requiredString(value.bundleVersion, 'bundleVersion'),
    schemaVersion: expectedSchemaVersion,
    entrypoint,
    entrypointUrl: entrypointUrl.toString(),
    capabilities,
    control: {
      protocol: expectedProtocol,
      transport: 'server-sent-events',
      snapshotPath,
      eventsPath,
      runtimeParameters: {
        programId: requiredString(
          value.control.runtimeParameters.programId,
          'control.runtimeParameters.programId',
          PARAMETER_PATTERN,
        ),
        apiBaseUrl: requiredString(
          value.control.runtimeParameters.apiBaseUrl,
          'control.runtimeParameters.apiBaseUrl',
          PARAMETER_PATTERN,
        ),
      },
      signals,
    },
  };
  if (files !== undefined) {
    manifest.files = files;
  }
  return manifest;
}

function isBlockedIpv4(address: string): boolean {
  // Callers pass only addresses that `isIP` already accepted as IPv4.
  const [a, b, c] = address.split('.').map((part) => Number(part));
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicNetworkAddress(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

export function readProgramTemplateManifest(
  value: unknown,
): ProgramTemplateManifest | null {
  if (
    !isRecord(value) ||
    value.kind !== PROGRAM_TEMPLATE_KIND ||
    (value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION &&
      value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION_V2) ||
    typeof value.entrypointUrl !== 'string' ||
    !Array.isArray(value.capabilities) ||
    !isRecord(value.control) ||
    !Array.isArray(value.control.signals)
  ) {
    return null;
  }
  return value as unknown as ProgramTemplateManifest;
}

function projectScene(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.layout)) return null;
  return {
    id: value.id,
    name: value.name,
    layoutId: value.layoutId,
    layout: {
      id: value.layout.id,
      name: value.layout.name,
      componentType: value.layout.componentType,
      settings: value.layout.settings,
    },
    chyronText: value.chyronText ?? null,
    metadata: value.metadata ?? null,
  };
}

export function projectProgramTemplateState(
  value: Record<string, unknown>,
  manifest: Pick<ProgramTemplateManifest, 'contractVersion'>,
): Record<string, unknown> {
  return {
    schemaVersion: programTemplateSchemaVersion(manifest),
    id: value.id,
    programId: value.programId,
    activeSceneId: value.activeSceneId ?? null,
    activeScene: projectScene(value.activeScene),
    stagedSceneId: value.stagedSceneId ?? null,
    stagedScene: projectScene(value.stagedScene),
    fadeToBlack: value.fadeToBlack === true,
    updatedAt: value.updatedAt,
    version: value.version,
    // The program-wide broadcast settings, in the broadcast_settings_update
    // `settings` shape, so a page loaded mid-override starts with it
    // (gaulatti/alcantara#177). v2 only, and absent when not supplied.
    ...(manifest.contractVersion === PROGRAM_TEMPLATE_CONTRACT_VERSION_V2 &&
    isRecord(value.broadcastSettings)
      ? { broadcastSettings: value.broadcastSettings }
      : {}),
  };
}

function copyFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

export function projectProgramTemplateSignal(
  value: unknown,
  manifest: ProgramTemplateManifest,
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (!manifest.control.signals.includes(value.type)) return null;
  if (V2_ONLY_SIGNALS.has(value.type) && manifest.contractVersion !== 2) {
    return null;
  }

  const common = {
    type: value.type,
    programId: value.programId,
    schemaVersion: programTemplateSchemaVersion(manifest),
    version: value.version,
  };
  if (
    value.type === 'scene_change' ||
    value.type === 'program_scenes_changed' ||
    value.type === 'program_media_groups_changed' ||
    value.type === 'program_stingers_changed'
  ) {
    if (!isRecord(value.state)) return null;
    return {
      ...common,
      ...copyFields(value, ['transitionId']),
      state: projectProgramTemplateState(
        { ...value.state, version: value.version },
        manifest,
      ),
    };
  }

  const fieldsBySignal: Record<string, string[]> = {
    audio_bus_update: ['settings', 'updatedAt'],
    broadcast_settings_update: ['settings', 'updatedAt'],
    heartbeat: ['sentAt'],
    instant_play: ['instant', 'triggeredAt'],
    instant_stop_all: ['triggeredAt'],
    program_reload: ['triggeredAt'],
    scene_cleared: ['updatedAt'],
    scene_instant_state: ['playback'],
    scene_instant_stop: ['sceneId', 'instantId', 'triggeredAt', 'fadeMs'],
    scene_instant_take: ['sceneId', 'instant', 'loop', 'triggeredAt'],
    scene_staged: ['stagedSceneId', 'updatedAt'],
    scene_update: ['updatedAt'],
    song_off_air: ['triggeredAt'],
    chyron_update: ['sceneId', 'chyronText'],
    fade_to_black: ['active'],
    song_playback_active: [
      'songId',
      'title',
      'artist',
      'coverUrl',
      'durationMs',
      'startedAt',
      'externalChartProvider',
      'externalChartRank',
      'externalChartSpins',
    ],
    song_playback_update: ['songId', 'positionMs', 'durationMs'],
    audio_levels: ['rms', 'peak'],
    audience_interaction_draw_start: [
      'sceneId',
      'componentType',
      'drawId',
      'durationSeconds',
      'candidateIds',
    ],
    audience_interaction_draw_end: [
      'sceneId',
      'componentType',
      'drawId',
      'selectedId',
    ],
  };
  const projected: Record<string, unknown> = {
    ...common,
    ...copyFields(value, fieldsBySignal[value.type] ?? []),
  };
  if (value.type === 'scene_staged' || value.type === 'scene_update') {
    projected.scene = projectScene(value.scene);
  } else if (value.type === 'song_queue_update') {
    if (Array.isArray(value.items)) {
      projected.items = value.items
        .filter(isRecord)
        .map((item) => copyFields(item, ['songId', 'title', 'artist']));
    }
  } else if (value.type === 'audience_interaction_draw_start') {
    // The contract names the draw's candidates `candidateIds`; the scenes service broadcasts them as `songIds`.
    projected.candidateIds = Array.isArray(value.candidateIds)
      ? value.candidateIds
      : Array.isArray(value.songIds)
        ? value.songIds
        : [];
    if (isRecord(value.slot)) {
      projected.slot = copyFields(value.slot, ['matchId', 'field']);
    }
  }
  return projected;
}

@Injectable()
export class ProgramTemplateService {
  protected readonly resolveHost = lookup;
  protected readonly fetchManifest = globalThis.fetch;

  constructor(@Optional() private readonly metrics?: ManagedMetricsService) {}

  async inspect(templateUrl: string): Promise<ProgramTemplateRegistration> {
    const startedAt = Date.now();
    try {
      const registration = await this.inspectManifest(templateUrl);
      this.metrics?.recordDependency(
        'program-template',
        'fetch',
        'success',
        (Date.now() - startedAt) / 1000,
      );
      return registration;
    } catch (error) {
      this.metrics?.recordDependency(
        'program-template',
        'fetch',
        'failure',
        (Date.now() - startedAt) / 1000,
      );
      throw error;
    }
  }

  private async inspectManifest(
    templateUrl: string,
    redirectCount = 0,
  ): Promise<ProgramTemplateRegistration> {
    const currentUrl = this.parseTemplateUrl(templateUrl);

    await this.assertSafeDestination(currentUrl);
    let response: Response;
    try {
      response = await this.fetchManifest(currentUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadRequestException('Template manifest could not be fetched');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new BadRequestException(
          'Template manifest redirect could not be followed safely',
        );
      }
      return this.inspectManifest(
        new URL(location, currentUrl).toString(),
        redirectCount + 1,
      );
    }
    if (!response.ok) {
      throw new BadRequestException(
        `Template manifest returned HTTP ${response.status}`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/(?:application\/json|\+json)(?:;|$)/i.test(contentType)) {
      throw new BadRequestException(
        'Template manifest must use a JSON content type',
      );
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MANIFEST_BYTES) {
      throw new BadRequestException('Template manifest is too large');
    }
    let body: Buffer;
    try {
      body = await readBoundedManifestBody(response);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Template manifest could not be read');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException('Template manifest is not valid JSON');
    }
    return {
      templateUrl: currentUrl.toString(),
      templateManifest: validateProgramTemplateManifest(decoded, currentUrl),
      templateVerifiedAt: new Date(),
    };
  }

  private parseTemplateUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      throw new BadRequestException('Template URL must be an absolute URL');
    }
    const localHttp =
      process.env.NODE_ENV !== 'production' &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !localHttp) {
      throw new BadRequestException(
        'Template URL must use HTTPS outside local development',
      );
    }
    if (
      process.env.NODE_ENV === 'production' &&
      !getApprovedTemplateOrigins().has(parsed.origin)
    ) {
      throw new BadRequestException(
        'Template URL origin is not an approved program-template publisher',
      );
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new BadRequestException(
        'Template URL cannot contain credentials, query parameters, or a fragment',
      );
    }
    return parsed;
  }

  private async assertSafeDestination(url: URL): Promise<void> {
    const localDevelopment =
      process.env.NODE_ENV !== 'production' &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (localDevelopment) return;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
      throw new BadRequestException(
        'Template URL must resolve to a public network address',
      );
    }
    if (isIP(url.hostname) && !isPublicNetworkAddress(url.hostname)) {
      throw new BadRequestException(
        'Template URL must resolve to a public network address',
      );
    }

    let addresses: Array<{ address: string }>;
    try {
      addresses = await this.resolveHost(url.hostname, {
        all: true,
        verbatim: true,
      });
    } catch {
      throw new BadRequestException('Template URL host could not be resolved');
    }
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicNetworkAddress(address))
    ) {
      throw new BadRequestException(
        'Template URL must resolve only to public network addresses',
      );
    }
  }
}
