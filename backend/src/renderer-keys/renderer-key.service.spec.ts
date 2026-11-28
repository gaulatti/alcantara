import { Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  LAST_USED_WRITE_MS,
  RendererKeyService,
  hashRendererKey,
} from './renderer-key.service';

type Row = {
  programStateId: number;
  keyHash: string;
  version: number;
  createdAt: Date;
  rotatedAt: Date;
  lastUsedAt: Date | null;
};

/** A stand-in for the two tables the service reads, keeping rows in memory. */
function setup() {
  const programs = new Map([
    ['station-a', 1],
    ['station-b', 2],
  ]);
  const rows = new Map<number, Row>();
  const prisma = {
    programState: {
      findUnique: jest.fn(async ({ where }: { where: { programId: string } }) =>
        programs.has(where.programId) ? { id: programs.get(where.programId)! } : null,
      ),
    },
    programRendererKey: {
      findUnique: jest.fn(
        async ({
          where,
          include,
        }: {
          where: { programStateId?: number; keyHash?: string };
          include?: unknown;
        }) => {
          const row =
            where.programStateId !== undefined
              ? rows.get(where.programStateId)
              : [...rows.values()].find((r) => r.keyHash === where.keyHash);
          if (!row) return null;
          if (!include) return { ...row };
          const programId = [...programs].find(([, id]) => id === row.programStateId)![0];
          return { ...row, programState: { programId } };
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { programStateId: number };
          create: Row;
          update: { keyHash: string; rotatedAt: Date; lastUsedAt: null; version: { increment: number } };
        }) => {
          const previous = rows.get(where.programStateId);
          const row: Row = previous
            ? {
                ...previous,
                keyHash: update.keyHash,
                rotatedAt: update.rotatedAt,
                lastUsedAt: update.lastUsedAt,
                version: previous.version + update.version.increment,
              }
            : { ...create, lastUsedAt: null };
          rows.set(where.programStateId, row);
          return { ...row };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { programStateId: number }; data: { lastUsedAt: Date } }) => {
          const row = rows.get(where.programStateId)!;
          row.lastUsedAt = data.lastUsedAt;
          return { ...row };
        },
      ),
    },
  };
  const service = new RendererKeyService(prisma as never);
  let clock = Date.parse('2026-11-28T10:00:00.000Z');
  service.now = () => clock;
  return {
    service,
    prisma,
    rows,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('RendererKeyService', () => {
  it('hashes a key as its SHA-256, so a stored hash can be checked but never read back', () => {
    expect(hashRendererKey('k')).toBe(createHash('sha256').update('k').digest('hex'));
  });

  it('issues a random key once, storing only its hash, and reports metadata that never carries either', async () => {
    const { service, rows } = setup();
    expect(await service.metadata('station-a')).toEqual({
      programId: 'station-a',
      exists: false,
      version: null,
      createdAt: null,
      rotatedAt: null,
      lastUsedAt: null,
    });
    const issued = await service.rotate('station-a');
    expect(issued.key).toMatch(/^alrk_[A-Za-z0-9_-]{43}$/);
    expect(issued.previousVersion).toBeNull();
    expect(issued.metadata).toEqual({
      programId: 'station-a',
      exists: true,
      version: 1,
      createdAt: '2026-11-28T10:00:00.000Z',
      rotatedAt: '2026-11-28T10:00:00.000Z',
      lastUsedAt: null,
    });
    expect(rows.get(1)!.keyHash).toBe(hashRendererKey(issued.key));
    expect(JSON.stringify(rows.get(1))).not.toContain(issued.key);
    const metadata = await service.metadata('station-a');
    expect(JSON.stringify(metadata)).not.toContain(issued.key);
    expect(JSON.stringify(metadata)).not.toContain(rows.get(1)!.keyHash);
  });

  it('replaces the key on rotation: the old one stops matching, and the version counts up', async () => {
    const { service, advance } = setup();
    const first = await service.rotate('station-a');
    advance(5_000);
    const second = await service.rotate('station-a');
    expect(second.key).not.toBe(first.key);
    expect(second.previousVersion).toBe(1);
    expect(second.metadata).toMatchObject({
      version: 2,
      createdAt: '2026-11-28T10:00:00.000Z',
      rotatedAt: '2026-11-28T10:00:05.000Z',
      lastUsedAt: null,
    });
    expect(await service.match(first.key, 'station-a')).toBe('none');
    expect(await service.match(second.key, 'station-a')).toBe('program');
  });

  it("matches a key to its own program only, and says when it is another program's", async () => {
    const { service } = setup();
    const a = await service.rotate('station-a');
    expect(await service.match(a.key, 'station-a')).toBe('program');
    expect(await service.match(a.key, 'station-b')).toBe('other-program');
    expect(await service.match('alrk_not-issued', 'station-a')).toBe('none');
    expect(await service.match(undefined, 'station-a')).toBe('none');
    expect(await service.match('', 'station-a')).toBe('none');
  });

  it('records a last use at most once a minute per program, and again after a rotation', async () => {
    const { service, prisma, advance } = setup();
    const a = await service.rotate('station-a');
    await service.match(a.key, 'station-a');
    advance(LAST_USED_WRITE_MS - 1);
    await service.match(a.key, 'station-a');
    expect(prisma.programRendererKey.update).toHaveBeenCalledTimes(1);
    advance(1);
    await service.match(a.key, 'station-a');
    expect(prisma.programRendererKey.update).toHaveBeenCalledTimes(2);
    expect((await service.metadata('station-a')).lastUsedAt).toBe('2026-11-28T10:01:00.000Z');
    const b = await service.rotate('station-a');
    await service.match(b.key, 'station-a');
    expect(prisma.programRendererKey.update).toHaveBeenCalledTimes(3);
  });

  it('never fails the caller when the last use cannot be written', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, prisma } = setup();
    const a = await service.rotate('station-a');
    prisma.programRendererKey.update.mockRejectedValueOnce(new TypeError('db down'));
    await expect(service.match(a.key, 'station-a')).resolves.toBe('program');
    expect(warn).toHaveBeenCalledWith('Renderer key last use was not recorded: TypeError');
    prisma.programRendererKey.update.mockRejectedValueOnce('not an error');
    jest.spyOn(service, 'now').mockReturnValue(Date.parse('2026-11-28T11:00:00.000Z'));
    await expect(service.match(a.key, 'station-a')).resolves.toBe('program');
    expect(warn).toHaveBeenCalledWith('Renderer key last use was not recorded: unknown');
    warn.mockRestore();
  });

  it('refuses a program that does not exist', async () => {
    const { service } = setup();
    await expect(service.metadata('nowhere')).rejects.toThrow(NotFoundException);
    await expect(service.rotate('nowhere')).rejects.toThrow(NotFoundException);
  });

  it('keeps the real clock by default', () => {
    const service = new RendererKeyService({} as never);
    expect(Math.abs(service.now() - Date.now())).toBeLessThan(1_000);
  });

  it('records Object for the database dependency when its module is not loaded yet', () => {
    jest.isolateModules(() => {
      jest.doMock('../prisma.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RendererKeyService: Isolated } = require('./renderer-key.service') as {
        RendererKeyService: new (...args: never[]) => unknown;
      };
      expect(Reflect.getMetadata('design:paramtypes', Isolated)).toEqual([Object]);
    });
    jest.dontMock('../prisma.service');
  });
});

