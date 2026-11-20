/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- tool answers are untyped JSON. */
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { z } from 'zod';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { ManagedMetricsService } from '../../observability/managed-metrics.service';
import { ProgramService } from '../../program/program.service';
import { UploadsController } from '../../uploads/uploads.controller';
import { UploadsService } from '../../uploads/uploads.service';
import { MCP_ACTION_EXECUTOR } from '../contract';
import { McpActionExecutor } from '../mcp-action.executor';
import { McpRegistry } from '../mcp-registry.service';
import { principalWith, specNamed } from './capabilities.testing';
import { MediaImportMcpTools } from './media-import';

// import_media_from_url: the audio upload of the console with the file fetched
// from an address. The service does the fetch under the outbound-request
// policy (its own spec) and the store; these specs pin what the capability
// adds: its row, its permission, its refusals, and that the address is never
// kept.

const ADDRESS = 'https://media.example.com/secret-path/track.mp3?sig=abc123';
const stored = {
  key: 'song/2026/11/20/track-1.mp3',
  url: 'https://bkt.s3.amazonaws.com/song/2026/11/20/track-1.mp3',
  bucket: 'bkt',
  contentType: 'audio/mpeg',
  sizeBytes: 4,
  metadata: { artist: 'The Band', title: 'Anthem', durationMs: 2000 },
};
const ctx = { principal: principalWith(ALCANTARA_PERMISSIONS.upload.create) };

const uploads = { importFromUrl: jest.fn() };
const spec = specNamed(
  new MediaImportMcpTools(uploads as never).specs(),
  'import_media_from_url',
);

beforeEach(() => {
  jest.clearAllMocks();
  uploads.importFromUrl.mockResolvedValue(stored);
});

describe('import_media_from_url', () => {
  it('is the W row of the upload permission, a capability, with a dry run and no confirm', () => {
    expect(spec).toMatchObject({
      permission: ALCANTARA_PERMISSIONS.upload.create,
      tier: 'W',
      firstClass: false,
    });
    expect(spec.dryRun).toBeDefined();
    expect(spec.confirmTarget).toBeUndefined();
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        UploadsController.prototype.uploadSong,
      ) ?? Reflect.getMetadata(REQUIRED_PERMISSION_KEY, UploadsController),
    ).toBe(spec.permission);
  });

  it('answers what the console upload answers, and passes the address only to the service', async () => {
    const out = await spec.run({ url: ADDRESS, kind: 'song' }, ctx);
    expect(uploads.importFromUrl).toHaveBeenCalledWith({
      kind: 'song',
      url: ADDRESS,
    });
    expect(out.result).toMatchObject({
      key: stored.key,
      url: stored.url,
      bucket: 'bkt',
      contentType: 'audio/mpeg',
      sizeBytes: 4,
      untrusted: { metadata: stored.metadata },
    });
    expect(JSON.stringify(out)).not.toContain('secret-path');
    expect(out.audit).toEqual({ target: 'import-song' });
  });

  it('plans without the address and changes nothing', async () => {
    const plan = await spec.dryRun!({ url: ADDRESS, kind: 'instant' }, ctx);
    expect(plan).toMatchObject({
      onAir: false,
      recoverable: true,
      affects: [],
    });
    expect(JSON.stringify(plan)).not.toContain('secret-path');
    expect(uploads.importFromUrl).not.toHaveBeenCalled();
  });

  it('reports the policy refusals as MCP codes, with its plain message', async () => {
    uploads.importFromUrl.mockRejectedValue(
      new BadRequestException('The address must use https.'),
    );
    await expect(
      spec.run({ url: ADDRESS, kind: 'song' }, ctx),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'The address must use https.',
    });
    for (const error of [
      new BadGatewayException('The address answered with an error status.'),
      new GatewayTimeoutException('The address did not answer in time.'),
      new InternalServerErrorException('Failed to upload file to S3'),
    ]) {
      uploads.importFromUrl.mockRejectedValue(error);
      await expect(
        spec.run({ url: ADDRESS, kind: 'song' }, ctx),
      ).rejects.toMatchObject({ code: 'unavailable', message: error.message });
    }
  });

  it('takes audio kinds only and an address of bounded length', () => {
    const shape = spec.shape;
    expect(shape.kind.safeParse('song').success).toBe(true);
    expect(shape.kind.safeParse('artwork').success).toBe(false);
    expect(shape.kind.safeParse('stinger').success).toBe(false);
    expect(shape.url.safeParse('x'.repeat(2001)).success).toBe(false);
  });
});

describe('import_media_from_url through the registry', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;

  async function connect(principal: ReturnType<typeof principalWith>) {
    const module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        McpRegistry,
        McpActionExecutor,
        { provide: MCP_ACTION_EXECUTOR, useExisting: McpActionExecutor },
        ManagedMetricsService,
        { provide: ProgramService, useValue: {} },
        { provide: UploadsService, useValue: uploads },
        MediaImportMcpTools,
      ],
    }).compile();
    await module.init();
    const tools = new Map<string, Handler>();
    module.get(McpRegistry).register(
      {
        registerTool: (
          name: string,
          _config: { inputSchema: z.ZodRawShape },
          handler: Handler,
        ) => tools.set(name, handler),
      } as never,
      principal,
      jest.fn(() => Promise.resolve(principal)) as never,
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await tools.get(name)!(args);
      return {
        body: JSON.parse(answer.content[0].text),
        isError: answer.isError === true,
        text: answer.content[0].text,
      };
    };
    return { module, call };
  }

  it('is listed and runs for a caller with upload.create, and the address appears nowhere', async () => {
    const { module, call } = await connect(
      principalWith(
        ALCANTARA_PERMISSIONS.access,
        ALCANTARA_PERMISSIONS.upload.create,
      ),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    expect(
      listed.body.capabilities.map((c: { name: string }) => c.name),
    ).toContain('import_media_from_url');
    const dry = await call('call_capability', {
      name: 'import_media_from_url',
      arguments: {
        url: ADDRESS,
        kind: 'song',
        dry_run: true,
        idempotency_key: 'key-00000002',
      },
    });
    expect(dry.isError).toBe(false);
    const done = await call('call_capability', {
      name: 'import_media_from_url',
      arguments: {
        url: ADDRESS,
        kind: 'song',
        idempotency_key: 'key-00000001',
      },
    });
    expect(done.isError).toBe(false);
    expect(done.body.key).toBe(stored.key);
    expect(dry.text + done.text).not.toContain('secret-path');
    await module.close();
  });

  it('is neither listed nor callable without upload.create', async () => {
    const { module, call } = await connect(
      principalWith(ALCANTARA_PERMISSIONS.access),
    );
    const listed = await call('list_capabilities', { limit: 100 });
    expect(
      listed.body.capabilities.map((c: { name: string }) => c.name),
    ).not.toContain('import_media_from_url');
    const refused = await call('call_capability', {
      name: 'import_media_from_url',
      arguments: {
        url: ADDRESS,
        kind: 'song',
        idempotency_key: 'key-00000001',
      },
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('forbidden');
    expect(refused.text).not.toContain('secret-path');
    expect(uploads.importFromUrl).not.toHaveBeenCalled();
    await module.close();
  });
});
