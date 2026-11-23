import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  buildConsumerReferences,
  mappingsFromMigrationReport,
  readMigrationReportFile,
  runPrincipalMigrationCli,
  type PompeiiMigrationReport,
} from './principals-cli';
import type { IdentityRow } from './principals';

function writeJson(value: unknown): string {
  const path = join(
    mkdtempSync(join(tmpdir(), 'principals-cov-')),
    'report.json',
  );
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const ref = (reference: string, subject: string, principalId?: string) => ({
  consumer: 'alcantara',
  reference,
  subject,
  ...(principalId === undefined ? {} : { principal_id: principalId }),
});

describe('readMigrationReportFile validation', () => {
  const valid = {
    references: [
      ref('SharedConsoleLayout:l1', ' s1 ', ' p1 '),
      ref('GuestEvent:e1', 's2'),
    ],
    collisions: [
      {
        consumer: 'alcantara',
        reference: 'SharedConsoleLayout:l1',
        principal_ids: [' p1 ', 'p2'],
      },
    ],
    missing: [ref('GuestEvent:e1', 's2')],
  };

  it('trims values and maps absent principals to null', () => {
    expect(readMigrationReportFile(writeJson(valid))).toEqual({
      references: [
        {
          consumer: 'alcantara',
          reference: 'SharedConsoleLayout:l1',
          subject: 's1',
          principalId: 'p1',
        },
        {
          consumer: 'alcantara',
          reference: 'GuestEvent:e1',
          subject: 's2',
          principalId: null,
        },
      ],
      collisions: [
        {
          consumer: 'alcantara',
          reference: 'SharedConsoleLayout:l1',
          principalIds: ['p1', 'p2'],
        },
      ],
      missing: [
        {
          consumer: 'alcantara',
          reference: 'GuestEvent:e1',
          subject: 's2',
          principalId: null,
        },
      ],
    });
  });

  it.each([null, 'text', 5])('rejects a non-object document %p', (document) => {
    expect(() => readMigrationReportFile(writeJson(document))).toThrow(
      'The input must be a Pompeii principal-migration report object.',
    );
  });

  it.each([
    [{ ...valid, references: undefined }],
    [{ ...valid, collisions: 'x' }],
    [{ ...valid, missing: {} }],
  ])('requires the three arrays', (document) => {
    expect(() => readMigrationReportFile(writeJson(document))).toThrow(
      'The Pompeii report needs references, collisions, and missing arrays.',
    );
  });

  it.each([
    [
      'null reference',
      { ...valid, references: [null] },
      'Pompeii reference 0 is not an object.',
    ],
    [
      'array reference',
      { ...valid, references: [valid.references[0], []] },
      'Pompeii reference 1 is not an object.',
    ],
    [
      'email',
      { ...valid, references: [{ ...ref('a:1', 's'), email: 'x@y.z' }] },
      'Pompeii reference 0 contains an email.',
    ],
    [
      'numeric principal',
      { ...valid, references: [{ ...ref('a:1', 's'), principal_id: 5 }] },
      'Pompeii reference 0 has an invalid principal_id.',
    ],
    [
      'blank principal',
      { ...valid, references: [ref('a:1', 's', '  ')] },
      'Pompeii reference 0 has an invalid principal_id.',
    ],
    [
      'blank consumer',
      { ...valid, references: [{ ...ref('a:1', 's'), consumer: ' ' }] },
      'Pompeii reference 0 needs a non-empty consumer.',
    ],
    [
      'missing reference',
      { ...valid, references: [{ consumer: 'alcantara', subject: 's' }] },
      'Pompeii reference 0 needs a non-empty reference.',
    ],
    [
      'numeric subject',
      { ...valid, references: [{ ...ref('a:1', 's'), subject: 5 }] },
      'Pompeii reference 0 needs a non-empty subject.',
    ],
    [
      'bad missing entry',
      { ...valid, missing: [7] },
      'Pompeii missing reference 0 is not an object.',
    ],
    [
      'collision not object',
      { ...valid, collisions: [null] },
      'Pompeii collision 0 is not an object.',
    ],
    [
      'collision array',
      { ...valid, collisions: [[]] },
      'Pompeii collision 0 is not an object.',
    ],
    [
      'collision no ids',
      { ...valid, collisions: [{ consumer: 'a', reference: 'r' }] },
      'Pompeii collision 0 needs at least two principal_ids.',
    ],
    [
      'collision one id',
      {
        ...valid,
        collisions: [{ consumer: 'a', reference: 'r', principal_ids: ['p'] }],
      },
      'Pompeii collision 0 needs at least two principal_ids.',
    ],
    [
      'collision non-string id',
      {
        ...valid,
        collisions: [
          { consumer: 'a', reference: 'r', principal_ids: ['p', 3] },
        ],
      },
      'Pompeii collision 0 needs at least two principal_ids.',
    ],
    [
      'collision blank id',
      {
        ...valid,
        collisions: [
          { consumer: 'a', reference: 'r', principal_ids: ['p', ' '] },
        ],
      },
      'Pompeii collision 0 needs at least two principal_ids.',
    ],
    [
      'collision blank reference',
      {
        ...valid,
        collisions: [
          { consumer: 'a', reference: '', principal_ids: ['p', 'q'] },
        ],
      },
      'Pompeii collision 0 needs a non-empty reference.',
    ],
  ])('rejects %s', (_label, document, message) => {
    expect(() => readMigrationReportFile(writeJson(document))).toThrow(message);
  });
});

describe('buildConsumerReferences', () => {
  it('skips rows without a usable subject and trims the rest', () => {
    const rows: IdentityRow[] = [
      {
        id: '1',
        model: 'SharedConsoleLayout',
        principalId: null,
        subject: ' s1 ',
      },
      { id: '2', model: 'GuestEvent', principalId: null, subject: '   ' },
      { id: '3', model: 'GuestInvitation', principalId: null, subject: null },
    ];
    expect(buildConsumerReferences(rows)).toEqual([
      {
        consumer: 'alcantara',
        reference: 'SharedConsoleLayout:1',
        subject: 's1',
      },
    ]);
  });
});

describe('mappingsFromMigrationReport consistency', () => {
  const rows: IdentityRow[] = [
    {
      id: 'l1',
      model: 'SharedConsoleLayout',
      principalId: null,
      subject: 's1',
    },
    { id: 'e1', model: 'GuestEvent', principalId: null, subject: 's2' },
  ];
  type Entry = PompeiiMigrationReport['references'][number];
  const entry = (
    reference: string,
    subject: string,
    principalId: string | null,
    consumer = 'alcantara',
  ): Entry => ({ consumer, reference, subject, principalId }) as Entry;
  const clean = (): PompeiiMigrationReport => ({
    references: [
      entry('SharedConsoleLayout:l1', 's1', 'p1'),
      entry('GuestEvent:e1', 's2', 'p2'),
    ],
    collisions: [],
    missing: [],
  });

  it('returns only resolved mappings', () => {
    const report = clean();
    report.references[1] = entry('GuestEvent:e1', 's2', null);
    report.missing = [entry('GuestEvent:e1', 's2', null)];
    expect(mappingsFromMigrationReport(report, rows)).toEqual([
      { principalId: 'p1', subject: 's1' },
    ]);
  });

  it('accepts a declared collision that matches the actual one', () => {
    const report = clean();
    report.references.push(entry('SharedConsoleLayout:l1', 's1', 'p9'));
    report.collisions = [
      {
        consumer: 'alcantara',
        reference: 'SharedConsoleLayout:l1',
        principalIds: ['p9', 'p1'],
      },
    ];
    expect(mappingsFromMigrationReport(report, rows)).toHaveLength(3);
  });

  it('rejects duplicate inventory references', () => {
    expect(() =>
      mappingsFromMigrationReport(clean(), [rows[0], rows[0]]),
    ).toThrow('The Alcantara migration inventory has duplicate references.');
  });

  it.each([
    [
      'non-Alcantara consumer',
      (r: PompeiiMigrationReport) => {
        r.references[0] = entry('SharedConsoleLayout:l1', 's1', 'p1', 'other');
      },
      'non-Alcantara consumer',
    ],
    [
      'unknown reference',
      (r: PompeiiMigrationReport) => {
        r.references.push(entry('GuestEvent:ghost', 's2', 'p'));
      },
      'unknown Alcantara reference',
    ],
    [
      'subject mismatch',
      (r: PompeiiMigrationReport) => {
        r.references[0] = entry('SharedConsoleLayout:l1', 'other', 'p1');
      },
      'subject does not match',
    ],
    [
      'duplicate result',
      (r: PompeiiMigrationReport) => {
        r.references.push(r.references[0]);
      },
      'duplicate reference result',
    ],
    [
      'partial coverage',
      (r: PompeiiMigrationReport) => {
        r.references.pop();
      },
      'does not cover the current Alcantara inventory',
    ],
  ])('rejects %s', (_label, mutate, message) => {
    const report = clean();
    mutate(report);
    expect(() => mappingsFromMigrationReport(report, rows)).toThrow(message);
  });

  it.each([
    [
      'declared missing from another consumer',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
        r.missing = [entry('GuestEvent:e1', 's2', null, 'other')];
      },
    ],
    [
      'declared missing that has a principal',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
        r.missing = [entry('GuestEvent:e1', 's2', 'p2')];
      },
    ],
    [
      'declared missing for an unknown reference',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
        r.missing = [entry('GuestEvent:zzz', 's2', null)];
      },
    ],
    [
      'declared missing with another subject',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
        r.missing = [entry('GuestEvent:e1', 'x', null)];
      },
    ],
    [
      'unreported missing reference',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
      },
    ],
    [
      'spurious declared missing',
      (r: PompeiiMigrationReport) => {
        r.missing = [entry('GuestEvent:e1', 's2', null)];
      },
    ],
    [
      'duplicate declared missing',
      (r: PompeiiMigrationReport) => {
        r.references[1] = entry('GuestEvent:e1', 's2', null);
        r.missing = [
          entry('GuestEvent:e1', 's2', null),
          entry('GuestEvent:e1', 's2', null),
        ];
      },
    ],
    [
      'same-size different missing sets',
      (r: PompeiiMigrationReport) => {
        r.references[0] = entry('SharedConsoleLayout:l1', 's1', null);
        r.missing = [entry('GuestEvent:e1', 's2', null)];
      },
    ],
  ])('rejects an inconsistent missing report: %s', (_label, mutate) => {
    const report = clean();
    mutate(report);
    expect(() => mappingsFromMigrationReport(report, rows)).toThrow(
      'The Pompeii missing-reference report is inconsistent.',
    );
  });

  it.each([
    [
      'unreported collision',
      (r: PompeiiMigrationReport) => {
        r.references.push(entry('SharedConsoleLayout:l1', 's1', 'p9'));
      },
    ],
    [
      'spurious collision',
      (r: PompeiiMigrationReport) => {
        r.collisions = [
          {
            consumer: 'alcantara',
            reference: 'GuestEvent:e1',
            principalIds: ['a', 'b'],
          },
        ];
      },
    ],
    [
      'collision from another consumer',
      (r: PompeiiMigrationReport) => {
        r.references.push(entry('SharedConsoleLayout:l1', 's1', 'p9'));
        r.collisions = [
          {
            consumer: 'other',
            reference: 'SharedConsoleLayout:l1',
            principalIds: ['p1', 'p9'],
          },
        ];
      },
    ],
    [
      'collision with other principals',
      (r: PompeiiMigrationReport) => {
        r.references.push(entry('SharedConsoleLayout:l1', 's1', 'p9'));
        r.collisions = [
          {
            consumer: 'alcantara',
            reference: 'SharedConsoleLayout:l1',
            principalIds: ['p1', 'p8'],
          },
        ];
      },
    ],
  ])('rejects an inconsistent collision report: %s', (_label, mutate) => {
    const report = clean();
    mutate(report);
    expect(() => mappingsFromMigrationReport(report, rows)).toThrow(
      'The Pompeii collision report is inconsistent.',
    );
  });
});

describe('runPrincipalMigrationCli', () => {
  const quiet = () => ({
    bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
    error: jest.fn(),
    log: jest.fn(),
  });

  function store(
    data: {
      preferences?: unknown[];
      layouts?: unknown[];
      invitations?: unknown[];
      events?: unknown[];
    } = {},
    counts: Partial<
      Record<'preference' | 'layout' | 'invitation' | 'event', number>
    > = {},
  ) {
    return {
      operatorPreference: {
        findMany: jest.fn().mockResolvedValue(data.preferences ?? []),
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: counts.preference ?? 1 }),
      },
      sharedConsoleLayout: {
        findMany: jest.fn().mockResolvedValue(data.layouts ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: counts.layout ?? 1 }),
      },
      guestInvitation: {
        findMany: jest.fn().mockResolvedValue(data.invitations ?? []),
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: counts.invitation ?? 1 }),
      },
      guestEvent: {
        findMany: jest.fn().mockResolvedValue(data.events ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: counts.event ?? 1 }),
      },
    };
  }

  function client(transaction: ReturnType<typeof store>) {
    const $transaction = jest.fn(async (cb: (tx: never) => Promise<unknown>) =>
      cb(transaction as never),
    );
    const $disconnect = jest.fn().mockResolvedValue(undefined);
    return {
      prisma: {
        $transaction,
        $disconnect,
        ...transaction,
      } as unknown as PrismaClient,
      $transaction,
      $disconnect,
    };
  }

  const allRows = {
    preferences: [{ deviceClass: 'desktop', principalId: null, subject: 'sp' }],
    layouts: [{ id: 'l1', ownerPrincipalId: null, ownerSubject: 'sl' }],
    invitations: [
      { id: 'i1', createdByIdentity: 'si', createdByPrincipalId: null },
    ],
    events: [
      {
        id: 'e1',
        details: { operatorIdentity: 'se', keep: 'x' },
      },
    ],
  };

  const preferenceRef = (subject: string, deviceClass: string) => {
    const { createHash } =
      require('node:crypto') as typeof import('node:crypto');
    return `OperatorPreference:preference-${createHash('sha256')
      .update(subject)
      .update('\0')
      .update(deviceClass)
      .digest('hex')
      .slice(0, 16)}`;
  };

  const fullReport = (overrides: Record<string, string | null> = {}) =>
    writeJson({
      references: [
        ref(preferenceRef('sp', 'desktop'), 'sp', overrides.sp ?? 'pp'),
        ref('SharedConsoleLayout:l1', 'sl', overrides.sl ?? 'pl'),
        ref('GuestInvitation:i1', 'si', overrides.si ?? 'pi'),
        ref('GuestEvent:e1', 'se', overrides.se ?? 'pe'),
      ],
      collisions: [],
      missing: [],
    });

  it.each([
    [
      [],
      'Usage: principals-cli <export|report|apply> <path> [--allow-conflicts]',
    ],
    [
      ['nope', 'x'],
      'Usage: principals-cli <export|report|apply> <path> [--allow-conflicts]',
    ],
    [['export'], 'A references or Pompeii report path is required.'],
    [['apply', ''], 'A references or Pompeii report path is required.'],
  ])('exits 2 for bad arguments %p', async (args, message) => {
    const deps = quiet();
    const createPrisma = jest.fn();
    await expect(
      runPrincipalMigrationCli(args, { ...deps, createPrisma }),
    ).resolves.toBe(2);
    expect(deps.error).toHaveBeenCalledWith(message);
    expect(deps.bootstrapDatabase).not.toHaveBeenCalled();
    expect(createPrisma).not.toHaveBeenCalled();
  });

  it('exports consumer references inside a serializable transaction', async () => {
    const deps = quiet();
    const writeReferences = jest.fn();
    const { prisma, $transaction, $disconnect } = client(store(allRows));
    await expect(
      runPrincipalMigrationCli(['export', '/out/refs.json'], {
        ...deps,
        createPrisma: () => prisma,
        writeReferences,
      }),
    ).resolves.toBe(0);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    const references = writeReferences.mock.calls[0][1] as Array<{
      reference: string;
      subject: string;
    }>;
    expect(writeReferences.mock.calls[0][0]).toBe('/out/refs.json');
    expect(references.map((r) => r.subject).sort()).toEqual([
      'se',
      'si',
      'sl',
      'sp',
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      'Wrote 4 Alcantara references for Pompeii.',
    );
    expect($disconnect).toHaveBeenCalledTimes(1);
  });

  it('collects guest events only when the details carry an operator identity', async () => {
    const deps = quiet();
    const writeReferences = jest.fn();
    const events = [
      { id: 'null', details: null },
      { id: 'array', details: [1] },
      { id: 'string', details: 'x' },
      { id: 'noident', details: {} },
      { id: 'numident', details: { operatorIdentity: 5 } },
      { id: 'blankident', details: { operatorIdentity: '  ' } },
      {
        id: 'ok',
        details: { operatorIdentity: 'seen', operatorPrincipalId: ' stored ' },
      },
      {
        id: 'badstored',
        details: { operatorIdentity: 'seen2', operatorPrincipalId: '  ' },
      },
    ];
    const { prisma } = client(store({ events }));
    await runPrincipalMigrationCli(['export', 'p'], {
      ...deps,
      createPrisma: () => prisma,
      writeReferences,
    });
    expect(writeReferences.mock.calls[0][1]).toEqual([
      { consumer: 'alcantara', reference: 'GuestEvent:ok', subject: 'seen' },
      {
        consumer: 'alcantara',
        reference: 'GuestEvent:badstored',
        subject: 'seen2',
      },
    ]);
  });

  it('reports a dry run and Pompeii blockers without writing', async () => {
    const deps = quiet();
    const tx = store(allRows);
    const { prisma, $transaction, $disconnect } = client(tx);
    await expect(
      runPrincipalMigrationCli(['report', fullReport()], {
        ...deps,
        createPrisma: () => prisma,
      }),
    ).resolves.toBe(0);
    expect($transaction).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('Canonical principal migration — dry run'),
    );
    expect(deps.log).toHaveBeenCalledWith(
      '\nPompeii blockers: 0 collision(s), 0 missing reference(s).',
    );
    for (const model of [
      tx.operatorPreference,
      tx.sharedConsoleLayout,
      tx.guestInvitation,
      tx.guestEvent,
    ]) {
      expect(model.updateMany).not.toHaveBeenCalled();
    }
    expect($disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects even when the report is rejected', async () => {
    const deps = quiet();
    const { prisma, $disconnect } = client(store(allRows));
    await expect(
      runPrincipalMigrationCli(
        ['report', writeJson({ references: [], collisions: [], missing: [] })],
        {
          ...deps,
          createPrisma: () => prisma,
        },
      ),
    ).rejects.toThrow('does not cover the current Alcantara inventory');
    expect($disconnect).toHaveBeenCalledTimes(1);
  });

  it('applies mapped rows to every model with compare-and-set guards', async () => {
    const deps = quiet();
    const tx = store(allRows);
    const { prisma, $transaction } = client(tx);
    await expect(
      runPrincipalMigrationCli(['apply', fullReport()], {
        ...deps,
        createPrisma: () => prisma,
      }),
    ).resolves.toBe(0);

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(tx.operatorPreference.updateMany).toHaveBeenCalledWith({
      data: { principalId: 'pp' },
      where: { deviceClass: 'desktop', principalId: null, subject: 'sp' },
    });
    expect(tx.sharedConsoleLayout.updateMany).toHaveBeenCalledWith({
      data: { ownerPrincipalId: 'pl' },
      where: { id: 'l1', ownerPrincipalId: null, ownerSubject: 'sl' },
    });
    expect(tx.guestInvitation.updateMany).toHaveBeenCalledWith({
      data: { createdByPrincipalId: 'pi' },
      where: { createdByIdentity: 'si', createdByPrincipalId: null, id: 'i1' },
    });
    expect(tx.guestEvent.updateMany).toHaveBeenCalledWith({
      data: {
        details: {
          operatorIdentity: 'se',
          keep: 'x',
          operatorPrincipalId: 'pe',
        },
      },
      where: {
        details: { equals: { operatorIdentity: 'se', keep: 'x' } },
        id: 'e1',
      },
    });
    expect(deps.log).toHaveBeenCalledWith(
      '\nApplied 4 canonical principal references.',
    );
    expect(deps.error).not.toHaveBeenCalled();
  });

  it.each([
    ['preference', 'OperatorPreference'],
    ['layout', 'SharedConsoleLayout'],
    ['invitation', 'GuestInvitation'],
    ['event', 'GuestEvent'],
  ] as const)(
    'aborts when the %s compare-and-set matches no row',
    async (key, model) => {
      const deps = quiet();
      const { prisma } = client(store(allRows, { [key]: 0 }));
      await expect(
        runPrincipalMigrationCli(['apply', fullReport()], {
          ...deps,
          createPrisma: () => prisma,
        }),
      ).rejects.toThrow(
        `${model} changed concurrently; no canonical principal changes were committed. Retry the migration.`,
      );
    },
  );

  it('refuses to apply while consumer conflicts remain, unless explicitly allowed', async () => {
    const conflicted = {
      ...allRows,
      layouts: [
        { id: 'l1', ownerPrincipalId: 'someone-else', ownerSubject: 'sl' },
      ],
    };
    const deps = quiet();
    const tx = store(conflicted);
    const { prisma } = client(tx);
    await expect(
      runPrincipalMigrationCli(['apply', fullReport()], {
        ...deps,
        createPrisma: () => prisma,
      }),
    ).resolves.toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      '\nRefusing to apply while Alcantara conflicts remain. Resolve them, or pass --allow-conflicts to migrate only the clean rows.',
    );
    expect(tx.operatorPreference.updateMany).not.toHaveBeenCalled();

    const allowed = quiet();
    const second = store(conflicted);
    await expect(
      runPrincipalMigrationCli(['apply', fullReport(), '--allow-conflicts'], {
        ...allowed,
        createPrisma: () => client(second).prisma,
      }),
    ).resolves.toBe(0);
    expect(second.sharedConsoleLayout.updateMany).not.toHaveBeenCalled();
    expect(second.operatorPreference.updateMany).toHaveBeenCalledTimes(1);
    expect(allowed.log).toHaveBeenCalledWith(
      '\nApplied 3 canonical principal references.',
    );
  });

  it('refuses to apply when Pompeii reports blockers', async () => {
    const deps = quiet();
    const tx = store(allRows);
    const { prisma } = client(tx);
    const path = writeJson({
      references: [
        ref(preferenceRef('sp', 'desktop'), 'sp'),
        ref('SharedConsoleLayout:l1', 'sl', 'pl'),
        ref('GuestInvitation:i1', 'si', 'pi'),
        ref('GuestEvent:e1', 'se', 'pe'),
      ],
      collisions: [],
      missing: [ref(preferenceRef('sp', 'desktop'), 'sp')],
    });
    await expect(
      runPrincipalMigrationCli(['apply', path], {
        ...deps,
        createPrisma: () => prisma,
      }),
    ).resolves.toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      '\nRefusing to apply: Pompeii reported 0 collision(s) and 1 missing reference(s).',
    );
    expect(tx.sharedConsoleLayout.updateMany).not.toHaveBeenCalled();
  });
});
