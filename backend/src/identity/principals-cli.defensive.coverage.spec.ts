import type { PrismaClient } from '@prisma/client';
import type { PlanRow } from './principals';

const mockApplicableChanges = jest.fn();

jest.mock('./principals', () => {
  const actual = jest.requireActual('./principals');
  return {
    ...actual,
    applicableChanges: (...args: unknown[]) => mockApplicableChanges(...args),
  };
});

import { runPrincipalMigrationCli } from './principals-cli';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const unexpected =
  'The current Alcantara migration inventory changed unexpectedly.';

function reportFor(reference: string, subject: string) {
  // A blank-subject inventory row is not part of the expected references.
  const references = subject
    ? [{ consumer: 'alcantara', reference, subject, principal_id: 'p' }]
    : [];
  const path = join(
    mkdtempSync(join(tmpdir(), 'principals-def-')),
    'report.json',
  );
  writeFileSync(
    path,
    JSON.stringify({
      references,
      collisions: [],
      missing: [],
    }),
  );
  return path;
}

function prismaWith(preferenceSubject: string) {
  const transaction = {
    operatorPreference: {
      findMany: jest.fn().mockResolvedValue([
        {
          deviceClass: 'desktop',
          principalId: null,
          subject: preferenceSubject,
        },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sharedConsoleLayout: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    guestInvitation: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    guestEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
  };
  return {
    transaction,
    prisma: {
      $transaction: jest.fn(async (cb: (tx: never) => Promise<unknown>) =>
        cb(transaction as never),
      ),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaClient,
  };
}

function runApply(plannedRows: PlanRow[], preferenceSubject = 'sp') {
  const id = `preference-${createHash('sha256')
    .update(preferenceSubject)
    .update('\0')
    .update('desktop')
    .digest('hex')
    .slice(0, 16)}`;
  mockApplicableChanges.mockReturnValue(
    plannedRows.map((row) => ({ ...row, id: row.id === 'REAL' ? id : row.id })),
  );
  const { prisma, transaction } = prismaWith(preferenceSubject);
  const error = jest.fn();
  const log = jest.fn();
  const promise = runPrincipalMigrationCli(
    ['apply', reportFor(`OperatorPreference:${id}`, preferenceSubject)],
    {
      bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
      createPrisma: () => prisma,
      error,
      log,
    },
  );
  return { promise, transaction, log, error };
}

describe('principal migration apply defensive guards', () => {
  beforeEach(() => jest.clearAllMocks());

  it('skips planned rows that carry no principal', async () => {
    const { promise, transaction, log } = runApply([
      {
        id: 'REAL',
        model: 'OperatorPreference',
        classification: 'mapped',
        principalId: null,
      },
    ]);
    await expect(promise).resolves.toBe(0);
    expect(transaction.operatorPreference.updateMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '\nApplied 0 canonical principal references.',
    );
  });

  it('aborts when a planned row is absent from the inventory', async () => {
    const { promise, transaction } = runApply([
      {
        id: 'ghost',
        model: 'OperatorPreference',
        classification: 'mapped',
        principalId: 'p',
      },
    ]);
    await expect(promise).rejects.toThrow(unexpected);
    expect(transaction.operatorPreference.updateMany).not.toHaveBeenCalled();
  });

  it('aborts when the inventory row has no subject', async () => {
    const { promise, transaction } = runApply(
      [
        {
          id: 'REAL',
          model: 'OperatorPreference',
          classification: 'mapped',
          principalId: 'p',
        },
      ],
      '',
    );
    await expect(promise).rejects.toThrow();
    expect(transaction.operatorPreference.updateMany).not.toHaveBeenCalled();
  });
});
