import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  mappingsFromMigrationReport,
  readMigrationReportFile,
  runPrincipalMigrationCli,
  type PompeiiMigrationReport,
} from './principals-cli';
import type { IdentityRow } from './principals';
import { loadDatabaseSecret } from '../config/database-secrets';

const fixturePath = join(
  __dirname,
  'fixtures',
  'pompeii-principal-migration-report.json',
);

function writeJson(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'principals-')), 'report.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function transactionWithRows({
  events = [],
  invitations = [],
  layouts = [],
  preferences = [],
  eventUpdateCount = 1,
  invitationUpdateCount = 1,
  layoutUpdateCount = 1,
  preferenceUpdateCount = 1,
}: {
  events?: unknown[];
  invitations?: unknown[];
  layouts?: unknown[];
  preferences?: unknown[];
  eventUpdateCount?: number;
  invitationUpdateCount?: number;
  layoutUpdateCount?: number;
  preferenceUpdateCount?: number;
} = {}) {
  return {
    operatorPreference: {
      findMany: jest.fn().mockResolvedValue(preferences),
      updateMany: jest.fn().mockResolvedValue({ count: preferenceUpdateCount }),
    },
    sharedConsoleLayout: {
      findMany: jest.fn().mockResolvedValue(layouts),
      updateMany: jest.fn().mockResolvedValue({ count: layoutUpdateCount }),
    },
    guestInvitation: {
      findMany: jest.fn().mockResolvedValue(invitations),
      updateMany: jest.fn().mockResolvedValue({ count: invitationUpdateCount }),
    },
    guestEvent: {
      findMany: jest.fn().mockResolvedValue(events),
      updateMany: jest.fn().mockResolvedValue({ count: eventUpdateCount }),
    },
  };
}

function clientWithTransaction(
  transaction: ReturnType<typeof transactionWithRows>,
) {
  const runTransaction = jest.fn(
    async (callback: (value: never) => Promise<unknown>) =>
      callback(transaction as never),
  );
  const client = {
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: runTransaction,
  } as unknown as PrismaClient;
  return { client, runTransaction };
}

function cleanReport(
  reference: string,
  subject: string,
  principalId: string,
): PompeiiMigrationReport {
  return {
    references: [{ consumer: 'alcantara', reference, subject, principalId }],
    collisions: [],
    missing: [],
  };
}

describe('Pompeii migration-report compatibility', () => {
  it('accepts the committed landed producer shape without manual reshaping', () => {
    const report = readMigrationReportFile(fixturePath);
    const rows: IdentityRow[] = [
      {
        id: 'layout-1',
        model: 'SharedConsoleLayout',
        principalId: null,
        subject: 'fictional-subject-a',
      },
      {
        id: 'invitation-1',
        model: 'GuestInvitation',
        principalId: null,
        subject: 'fictional-subject-b',
      },
      {
        id: 'event-1',
        model: 'GuestEvent',
        principalId: null,
        subject: 'fictional-subject-b',
      },
    ];

    expect(mappingsFromMigrationReport(report, rows)).toEqual([
      {
        principalId: 'fictional-principal-a',
        subject: 'fictional-subject-a',
      },
      {
        principalId: 'fictional-principal-b',
        subject: 'fictional-subject-b',
      },
      {
        principalId: 'fictional-principal-b',
        subject: 'fictional-subject-b',
      },
    ]);
  });

  it('rejects the old hand-authored mapping array and identity-bearing extras', () => {
    expect(() =>
      readMigrationReportFile(
        writeJson([{ principalId: 'principal-a', subject: 'subject-a' }]),
      ),
    ).toThrow(/Pompeii principal-migration report object/);
    expect(() =>
      readMigrationReportFile(
        writeJson({
          references: [
            {
              consumer: 'alcantara',
              reference: 'SharedConsoleLayout:layout-1',
              subject: 'subject-a',
              principal_id: 'principal-a',
              email: 'person@example.test',
            },
          ],
          collisions: [],
          missing: [],
        }),
      ),
    ).toThrow(/never from an email address/);
  });

  it('requires the Alcantara consumer and exact current reference inventory', () => {
    const rows: IdentityRow[] = [
      {
        id: 'layout-1',
        model: 'SharedConsoleLayout',
        principalId: null,
        subject: 'subject-a',
      },
    ];
    const wrongConsumer = cleanReport(
      'SharedConsoleLayout:layout-1',
      'subject-a',
      'principal-a',
    );
    wrongConsumer.references[0].consumer = 'other' as never;
    expect(() => mappingsFromMigrationReport(wrongConsumer, rows)).toThrow(
      /non-Alcantara consumer/,
    );

    expect(() =>
      mappingsFromMigrationReport(
        cleanReport('SharedConsoleLayout:other', 'subject-a', 'principal-a'),
        rows,
      ),
    ).toThrow(/unknown Alcantara reference/);
  });
});

describe('principal migration CLI safety', () => {
  const quiet = { error: jest.fn(), log: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('loads the Arauco database secret before Prisma construction or access', async () => {
    const order: string[] = [];
    const transaction = transactionWithRows();
    const { client: prisma, runTransaction } =
      clientWithTransaction(transaction);
    const environment: {
      ARAUCO_SECRET_ID: string;
      AWS_REGION: string;
      DATABASE_URL?: string;
    } = {
      ARAUCO_SECRET_ID: 'fictional-arauco-secret',
      AWS_REGION: 'us-east-1',
    };
    const send = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'alcantara',
        password: 'fictional-password',
        host: 'database.example.test',
        port: 5432,
        dbname: 'alcantara',
      }),
    });

    await expect(
      runPrincipalMigrationCli(['export', 'references.json'], {
        bootstrapDatabase: () => {
          order.push('bootstrap');
          return loadDatabaseSecret(environment, { send });
        },
        createPrisma: () => {
          expect(environment.DATABASE_URL).toContain(
            'database.example.test:5432/alcantara',
          );
          order.push('prisma');
          return prisma;
        },
        writeReferences: () => {
          order.push('write');
        },
        ...quiet,
      }),
    ).resolves.toBe(0);

    expect(order).toEqual(['bootstrap', 'prisma', 'write']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('aborts before Prisma construction or mutation when secret loading fails', async () => {
    const createPrisma = jest.fn();

    await expect(
      runPrincipalMigrationCli(['apply', fixturePath], {
        bootstrapDatabase: jest
          .fn()
          .mockRejectedValue(new Error('database bootstrap failed')),
        createPrisma,
        ...quiet,
      }),
    ).rejects.toThrow('database bootstrap failed');
    expect(createPrisma).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { collisions: [], missing: [{}] }],
    ['collision', { collisions: [{}], missing: [] }],
  ])('refuses producer %s blockers before any update', async (_, blocker) => {
    const report = cleanReport(
      'SharedConsoleLayout:layout-1',
      'subject-a',
      'principal-a',
    );
    if (blocker.missing.length) {
      report.references[0].principalId = null;
      report.missing = [report.references[0]];
    } else {
      report.references.push({
        ...report.references[0],
        principalId: 'principal-b',
      });
      report.collisions = [
        {
          consumer: 'alcantara',
          reference: 'SharedConsoleLayout:layout-1',
          principalIds: ['principal-a', 'principal-b'],
        },
      ];
    }
    const transaction = transactionWithRows({
      layouts: [
        {
          id: 'layout-1',
          ownerPrincipalId: null,
          ownerSubject: 'subject-a',
        },
      ],
    });
    const { client: prisma } = clientWithTransaction(transaction);

    await expect(
      runPrincipalMigrationCli(
        [
          'apply',
          writeJson({
            references: report.references.map((reference) => ({
              consumer: reference.consumer,
              reference: reference.reference,
              subject: reference.subject,
              ...(reference.principalId
                ? { principal_id: reference.principalId }
                : {}),
            })),
            collisions: report.collisions.map((collision) => ({
              consumer: collision.consumer,
              reference: collision.reference,
              principal_ids: collision.principalIds,
            })),
            missing: report.missing.map((reference) => ({
              consumer: reference.consumer,
              reference: reference.reference,
              subject: reference.subject,
            })),
          }),
        ],
        {
          bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
          createPrisma: () => prisma,
          ...quiet,
        },
      ),
    ).resolves.toBe(1);
    expect(transaction.sharedConsoleLayout.updateMany).not.toHaveBeenCalled();
  });

  it('aborts the serializable apply when a scalar compare-and-set is stale', async () => {
    const transaction = transactionWithRows({
      layoutUpdateCount: 0,
      layouts: [
        {
          id: 'layout-1',
          ownerPrincipalId: null,
          ownerSubject: 'subject-a',
        },
      ],
    });
    const { client: prisma } = clientWithTransaction(transaction);
    const report = cleanReport(
      'SharedConsoleLayout:layout-1',
      'subject-a',
      'principal-a',
    );

    await expect(
      runPrincipalMigrationCli(
        [
          'apply',
          writeJson({
            references: [
              {
                consumer: 'alcantara',
                reference: report.references[0].reference,
                subject: 'subject-a',
                principal_id: 'principal-a',
              },
            ],
            collisions: [],
            missing: [],
          }),
        ],
        {
          bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
          createPrisma: () => prisma,
          ...quiet,
        },
      ),
    ).rejects.toThrow(/changed concurrently/);
    expect(transaction.sharedConsoleLayout.updateMany).toHaveBeenCalledWith({
      data: { ownerPrincipalId: 'principal-a' },
      where: {
        id: 'layout-1',
        ownerPrincipalId: null,
        ownerSubject: 'subject-a',
      },
    });
    expect(quiet.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Applied'),
    );
  });

  it('compare-and-sets the complete GuestEvent JSON and aborts a concurrent edit', async () => {
    const details = {
      note: 'preserve this concurrent boundary',
      operatorIdentity: 'subject-a',
    };
    const transaction = transactionWithRows({
      eventUpdateCount: 0,
      events: [{ details, id: 'event-1' }],
    });
    const { client: prisma } = clientWithTransaction(transaction);

    await expect(
      runPrincipalMigrationCli(
        [
          'apply',
          writeJson({
            references: [
              {
                consumer: 'alcantara',
                reference: 'GuestEvent:event-1',
                subject: 'subject-a',
                principal_id: 'principal-a',
              },
            ],
            collisions: [],
            missing: [],
          }),
        ],
        {
          bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
          createPrisma: () => prisma,
          ...quiet,
        },
      ),
    ).rejects.toThrow(/changed concurrently/);
    expect(transaction.guestEvent.updateMany).toHaveBeenCalledWith({
      data: {
        details: { ...details, operatorPrincipalId: 'principal-a' },
      },
      where: { details: { equals: details }, id: 'event-1' },
    });
    expect(quiet.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Applied'),
    );
  });
});
