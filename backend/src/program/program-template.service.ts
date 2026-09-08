import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ManagedMetricsService } from '../observability/managed-metrics.service';

export const PROGRAM_TEMPLATE_KIND = 'alcantara.program-template';
export const PROGRAM_TEMPLATE_CONTRACT_VERSION = 1;
export const PROGRAM_TEMPLATE_PROTOCOL = 'alcantara.program.v1';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MANIFEST_TIMEOUT_MS = 5_000;
const PRODUCTION_TEMPLATE_ORIGINS = new Set(['https://cdn.fifthbell.com']);
const TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PARAMETER_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const SIGNAL_PATTERN = /^[a-z][a-z0-9_]*$/;

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

export interface ProgramTemplateManifest {
  kind: typeof PROGRAM_TEMPLATE_KIND;
  contractVersion: typeof PROGRAM_TEMPLATE_CONTRACT_VERSION;
  id: string;
  name: string;
  package: string;
  bundleVersion: string;
  schemaVersion: number;
  entrypoint: string;
  entrypointUrl: string;
  capabilities: string[];
  control: {
    protocol: typeof PROGRAM_TEMPLATE_PROTOCOL;
    transport: 'server-sent-events';
    snapshotPath: string;
    eventsPath: string;
    runtimeParameters: {
      programId: string;
      apiBaseUrl: string;
    };
    signals: string[];
  };
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
  if (value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION) {
    throw new BadRequestException(
      `Unsupported template contract version ${String(value.contractVersion)}`,
    );
  }
  if (value.schemaVersion !== 1) {
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

  if (!isRecord(value.control)) {
    throw new BadRequestException('Template manifest control is required');
  }
  if (value.control.protocol !== PROGRAM_TEMPLATE_PROTOCOL) {
    throw new BadRequestException(
      `Template manifest control protocol must be ${PROGRAM_TEMPLATE_PROTOCOL}`,
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
  const unsupportedSignal = signals.find(
    (signal) => !PROGRAM_TEMPLATE_SIGNALS.has(signal),
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

  return {
    kind: PROGRAM_TEMPLATE_KIND,
    contractVersion: PROGRAM_TEMPLATE_CONTRACT_VERSION,
    id: requiredString(value.id, 'id', TOKEN_PATTERN),
    name: requiredString(value.name, 'name'),
    package: requiredString(value.package, 'package'),
    bundleVersion: requiredString(value.bundleVersion, 'bundleVersion'),
    schemaVersion: 1,
    entrypoint,
    entrypointUrl: entrypointUrl.toString(),
    capabilities,
    control: {
      protocol: PROGRAM_TEMPLATE_PROTOCOL,
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
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = octets;
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
    value.contractVersion !== PROGRAM_TEMPLATE_CONTRACT_VERSION ||
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
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: value.id,
    programId: value.programId,
    activeSceneId: value.activeSceneId ?? null,
    activeScene: projectScene(value.activeScene),
    stagedSceneId: value.stagedSceneId ?? null,
    stagedScene: projectScene(value.stagedScene),
    fadeToBlack: value.fadeToBlack === true,
    updatedAt: value.updatedAt,
    version: value.version,
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

  const common = {
    type: value.type,
    programId: value.programId,
    schemaVersion: 1,
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
      state: projectProgramTemplateState({
        ...value.state,
        version: value.version,
      }),
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
  };
  const projected: Record<string, unknown> = {
    ...common,
    ...copyFields(value, fieldsBySignal[value.type] ?? []),
  };
  if (value.type === 'scene_staged' || value.type === 'scene_update') {
    projected.scene = projectScene(value.scene);
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
  ): Promise<ProgramTemplateRegistration> {
    let currentUrl = this.parseTemplateUrl(templateUrl);

    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
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
        currentUrl = this.parseTemplateUrl(
          new URL(location, currentUrl).toString(),
        );
        continue;
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

    throw new BadRequestException('Template manifest could not be fetched');
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
      !PRODUCTION_TEMPLATE_ORIGINS.has(parsed.origin)
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
