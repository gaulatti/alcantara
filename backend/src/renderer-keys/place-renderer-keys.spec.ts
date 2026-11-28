import { hashRendererKey as serviceHash } from './renderer-key.service';

// gaulatti/alcantara#884: the script that gives each program's machines its own key, through a pipe, never shown.
// Fictional values, built here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const placement = require('../../scripts/place-renderer-keys.cjs') as {
  hashRendererKey(key: string): string;
  newRendererKey(): string;
  hostAllowed(url: string, allowRemote: boolean): boolean;
  parseArgs(argv: string[]): {
    step: string;
    programs: string[];
    rotate: boolean;
    dryRun: boolean;
    allowRemote: boolean;
  };
  issueKeys(options: Record<string, unknown>): Promise<number>;
  readKeyLines(text: string): Array<Record<string, unknown>>;
  writeKeys(options: Record<string, unknown>): Promise<void>;
  RECENT_USE_MS: number;
};

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const KEY_A = `alrk_${'A'.repeat(43)}`;
const KEY_B = `alrk_${'B'.repeat(43)}`;

/** A database with two programs: station-a with no key, station-b with version 4, last used `lastUsedAt`. */
function fakeDb(lastUsedAt: Date | null = null) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let version = 4;
  const db = {
    queries,
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.startsWith('SELECT')) {
        const programId = values?.[0];
        if (programId === 'station-a')
          return { rows: [{ id: 1, version: null, lastUsedAt: null }] };
        if (programId === 'station-b')
          return { rows: [{ id: 2, version, lastUsedAt }] };
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO "ProgramRendererKey"')) {
        version = values?.[0] === 2 ? version + 1 : 1;
        return { rows: [{ version }] };
      }
      return { rows: [] };
    }),
  };
  return db;
}

function run(options: Record<string, unknown>) {
  const said: string[] = [];
  const emitted: Array<Record<string, unknown>> = [];
  return {
    said,
    emitted,
    result: placement.issueKeys({
      programs: ['station-a'],
      rotate: false,
      dryRun: false,
      say: (line: string) => said.push(line),
      emit: (entry: Record<string, unknown>) => emitted.push(entry),
      now: () => NOW,
      newKey: () => KEY_A,
      ...options,
    }),
  };
}

describe('place-renderer-keys: keys', () => {
  it('makes and hashes keys exactly as the backend checks them', () => {
    expect(placement.hashRendererKey(KEY_A)).toBe(serviceHash(KEY_A));
    expect(placement.newRendererKey()).toMatch(/^alrk_[A-Za-z0-9_-]{43}$/);
    expect(placement.newRendererKey()).not.toBe(placement.newRendererKey());
  });

  it('reads its step, programs and flags, and refuses a program that is not an id', () => {
    expect(
      placement.parseArgs([
        'issue',
        '--program',
        'a',
        '--program',
        'a',
        '--program',
        'b',
        '--rotate',
        '--dry-run',
        '--allow-remote',
      ]),
    ).toEqual({
      step: 'issue',
      programs: ['a', 'b'],
      rotate: true,
      dryRun: true,
      allowRemote: true,
    });
    expect(placement.parseArgs(['write'])).toMatchObject({
      step: 'write',
      programs: [],
      rotate: false,
      dryRun: false,
    });
    expect(() => placement.parseArgs(['issue', '--program'])).toThrow(
      '--program needs a program id',
    );
    expect(() =>
      placement.parseArgs(['issue', '--program', 'news/main']),
    ).toThrow('--program needs a program id');
  });

  it('writes only to a local database unless --allow-remote is given', () => {
    expect(
      placement.hostAllowed('postgresql://u:p@postgres:5432/db', false),
    ).toBe(true);
    expect(
      placement.hostAllowed('postgresql://u:p@db.example.test:5432/db', false),
    ).toBe(false);
    expect(
      placement.hostAllowed('postgresql://u:p@db.example.test:5432/db', true),
    ).toBe(true);
  });
});

describe('place-renderer-keys issue', () => {
  it('issues a first key in one transaction with its operator change, and emits it on the pipe only', async () => {
    const db = fakeDb();
    const { said, emitted, result } = run({ db });
    expect(await result).toBe(0);
    expect(db.queries.map((query) => query.text.split(' ')[0])).toEqual([
      'SELECT',
      'BEGIN',
      'INSERT',
      'INSERT',
      'COMMIT',
    ]);
    expect(db.queries[2].values).toEqual([1, serviceHash(KEY_A)]);
    const change = db.queries[3].values!;
    expect(change.slice(1, 5)).toEqual([
      'station-a',
      'script',
      'place-renderer-keys',
      'program.rotate-renderer-key',
    ]);
    // The record takes the program's team from its Program row (gaulatti/alcantara#122).
    expect(db.queries[3].text).toContain(
      '(SELECT "teamId" FROM "Program" WHERE "programId" = $2)',
    );
    expect(JSON.parse(change[5] as string)).toEqual({
      target: { kind: 'program', id: 'station-a' },
      changed: ['rendererKey', 'version'],
      before: { version: null },
      after: { version: 1 },
    });
    expect(emitted).toEqual([
      { programId: 'station-a', version: 1, key: KEY_A },
    ]);
    expect(said).toEqual(['station-a: issued version 1']);
    expect(JSON.stringify(db.queries)).not.toContain(KEY_A);
  });

  it('keeps an existing key unless --rotate is given, emitting no key for it', async () => {
    const db = fakeDb(new Date(NOW - 60_000));
    const { said, emitted, result } = run({ db, programs: ['station-b'] });
    expect(await result).toBe(0);
    expect(db.queries).toHaveLength(1);
    expect(emitted).toEqual([
      { programId: 'station-b', version: 4, kept: true },
    ]);
    expect(said).toEqual([
      'station-b: kept, version 4 (pass --rotate to replace it)',
    ]);
  });

  it('rotates with --rotate, warning when a machine used the key in the last 15 minutes', async () => {
    const recent = run({
      db: fakeDb(new Date(NOW - placement.RECENT_USE_MS + 1)),
      programs: ['station-b'],
      rotate: true,
    });
    expect(await recent.result).toBe(0);
    expect(recent.said[0]).toMatch(
      /^station-b: warning: version 4 was used in the last 15 minutes; .*stop until they get version 5$/,
    );
    expect(recent.said[1]).toBe('station-b: rotated version 5');
    expect(recent.emitted).toEqual([
      { programId: 'station-b', version: 5, key: KEY_A },
    ]);
    const idle = run({
      db: fakeDb(new Date(NOW - placement.RECENT_USE_MS)),
      programs: ['station-b'],
      rotate: true,
    });
    await idle.result;
    expect(idle.said).toEqual(['station-b: rotated version 5']);
  });

  it('changes nothing on a dry run, and says what it would do', async () => {
    const db = fakeDb();
    const { said, emitted, result } = run({
      db,
      programs: ['station-a', 'station-b'],
      rotate: true,
      dryRun: true,
    });
    expect(await result).toBe(0);
    expect(db.queries.every((query) => query.text.startsWith('SELECT'))).toBe(
      true,
    );
    expect(emitted).toEqual([]);
    expect(said).toEqual([
      'station-a: would issue version 1',
      'station-b: would rotate version 5',
    ]);
  });

  it('counts a program that does not exist, and rolls back a write that fails', async () => {
    const missing = run({ db: fakeDb(), programs: ['nowhere'] });
    expect(await missing.result).toBe(1);
    expect(missing.said).toEqual(['nowhere: no such program; nothing changed']);
    const db = fakeDb();
    db.query.mockImplementation(async (text: string) => {
      db.queries.push({ text });
      if (text.startsWith('SELECT'))
        return { rows: [{ id: 1, version: null, lastUsedAt: null }] };
      if (text.startsWith('INSERT INTO "OperatorChangeRecord"'))
        throw new Error('db down');
      return { rows: [{ version: 1 }] };
    });
    const failing = run({ db });
    await expect(failing.result).rejects.toThrow('db down');
    expect(
      db.queries.map((query) => query.text.split(' ')[0]).slice(-1),
    ).toEqual(['ROLLBACK']);
    expect(failing.emitted).toEqual([]);
  });
});

describe('place-renderer-keys write', () => {
  const secret = {
    palazzoAllowedUrls: 'http://palazzo:3100',
    webrtcRendererKey: 'shared-fictional',
    webrtcProgramKeys: { 'station-c': KEY_B },
  };
  const lines = (...entries: unknown[]) =>
    entries.map((entry) => JSON.stringify(entry)).join('\n');

  function write(input: string, dryRun = false) {
    const reported: string[] = [];
    const said: string[] = [];
    const putSecret = jest.fn(async () => undefined);
    const validate = jest.fn();
    return {
      reported,
      said,
      putSecret,
      validate,
      done: placement.writeKeys({
        input,
        dryRun,
        getSecret: async () => JSON.stringify(secret),
        putSecret,
        validate,
        report: (line: string) => reported.push(line),
        say: (line: string) => said.push(line),
      }),
    };
  }

  it('merges the issued keys, keeping every other field and every placed key, validated first', async () => {
    const run = write(
      lines(
        { programId: 'station-a', version: 1, key: KEY_A },
        { programId: 'station-b', version: 4, kept: true },
        { programId: 'station-c', version: 2, kept: true },
      ),
    );
    await run.done;
    const written = JSON.parse(
      (run.putSecret.mock.calls[0] as unknown as [string])[0],
    );
    expect(written).toEqual({
      ...secret,
      webrtcProgramKeys: { 'station-c': KEY_B, 'station-a': KEY_A },
    });
    expect(run.validate).toHaveBeenCalledWith(JSON.stringify(written));
    expect(run.reported).toEqual([
      'station-b: version 4, kept, holder uses shared',
      'station-c: version 2, kept, already placed',
      'station-a: version 1, written',
    ]);
    for (const text of [...run.reported, ...run.said]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
      expect(text).not.toContain('shared-fictional');
    }
  });

  it('writes nothing on a dry run, or when every program was kept', async () => {
    const dry = write(
      lines({ programId: 'station-a', version: 1, key: KEY_A }),
      true,
    );
    await dry.done;
    expect(dry.putSecret).not.toHaveBeenCalled();
    expect(dry.validate).toHaveBeenCalled();
    expect(dry.reported).toEqual(['station-a: version 1, would be written']);
    expect(dry.said).toEqual([
      'dry run: the secret is unchanged, and the issued keys are not placed',
    ]);
    const kept = write(
      lines({ programId: 'station-b', version: 4, kept: true }),
    );
    await kept.done;
    expect(kept.putSecret).not.toHaveBeenCalled();
    expect(kept.validate).not.toHaveBeenCalled();
  });

  it('writes nothing when the secret would not validate, and marks the issued keys as not placed', async () => {
    const run = write(
      lines({ programId: 'station-a', version: 1, key: KEY_A }),
    );
    run.validate.mockImplementation(() => {
      throw new Error(
        'Alcantara runtime configuration field webrtcProgramKeys is malformed',
      );
    });
    await expect(run.done).rejects.toMatchObject({
      message: expect.stringContaining('webrtcProgramKeys is malformed'),
      unplaced: true,
    });
    expect(run.putSecret).not.toHaveBeenCalled();
  });

  it('says a dry run with nothing on the input has nothing to write, and marks no failure of one as unplaced', async () => {
    const empty = write('', true);
    await empty.done;
    expect(empty.reported).toEqual(['dry run: nothing to write']);
    const dry = write(
      lines({ programId: 'station-a', version: 1, key: KEY_A }),
      true,
    );
    dry.validate.mockImplementation(() => {
      throw new Error('malformed');
    });
    await expect(dry.done).rejects.not.toHaveProperty('unplaced');
    const kept = write(
      lines({ programId: 'station-b', version: 4, kept: true }),
    );
    kept.putSecret.mockRejectedValue(new Error('never called'));
    await kept.done;
    const failing = write(
      lines({ programId: 'station-a', version: 1, key: KEY_A }),
    );
    failing.putSecret.mockRejectedValue('not an error');
    await expect(failing.done).rejects.toBe('not an error');
  });

  it('starts a secret with no program keys, and refuses input that is not key lines', async () => {
    const reported: string[] = [];
    const putSecret = jest.fn(async () => undefined);
    await placement.writeKeys({
      input: lines({ programId: 'station-a', version: 1, key: KEY_A }),
      getSecret: async () => '{"palazzoAllowedUrls":"x"}',
      putSecret,
      validate: () => undefined,
      report: (line: string) => reported.push(line),
      say: () => undefined,
    });
    expect(
      JSON.parse((putSecret.mock.calls[0] as unknown as [string])[0]),
    ).toEqual({
      palazzoAllowedUrls: 'x',
      webrtcProgramKeys: { 'station-a': KEY_A },
    });
    expect(() => placement.readKeyLines('')).not.toThrow();
    await expect(write('\n').done).rejects.toThrow(
      'no key lines on the input; nothing written',
    );
    for (const bad of [
      'not json',
      'null',
      lines({ programId: 'news/main', version: 1, key: KEY_A }),
      lines({ programId: 'station-a', version: '1', key: KEY_A }),
      lines({ programId: 'station-a', version: 1, key: 'not-a-key' }),
      lines({ programId: 'station-a', version: 1, kept: true, key: KEY_A }),
      lines({ programId: 4, version: 1, key: KEY_A }),
    ])
      expect(() => placement.readKeyLines(bad)).toThrow(
        'the input has a line that is not a key line; nothing written',
      );
  });
});
