import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('principal migration hostile and stale producer inputs', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'alcantara-principal-boundaries-'));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  function file(value: unknown) {
    const filename = join(directory, `${randomUUID()}.json`);
    writeFileSync(filename, JSON.stringify(value));
    return filename;
  }
  const row: IdentityRow = {
    id: 'layout-1',
    model: 'SharedConsoleLayout',
    subject: 'subject-a',
    principalId: null,
  };
  const reference = {
    consumer: 'alcantara' as const,
    reference: 'SharedConsoleLayout:layout-1',
    subject: 'subject-a',
    principalId: 'principal-a',
  };
  const wire = {
    consumer: 'alcantara',
    reference: reference.reference,
    subject: reference.subject,
    principal_id: reference.principalId,
  };
  const report = (): PompeiiMigrationReport => ({
    references: [{ ...reference }],
    collisions: [],
    missing: [],
  });

  it.each([
    {},
    { references: [], collisions: [] },
    { references: {}, collisions: [], missing: [] },
    { references: [], collisions: null, missing: [] },
    { references: [], collisions: [], missing: {} },
  ])('requires complete native producer array fields (%#)', (value) => {
    expect(() => readMigrationReportFile(file(value))).toThrow(
      'references, collisions, and missing arrays',
    );
  });

  it.each([null, [], 'reference'].map((value) => [value]))(
    'rejects a non-object producer reference (%#)',
    (value) => {
      expect(() =>
        readMigrationReportFile(
          file({ references: [value], collisions: [], missing: [] }),
        ),
      ).toThrow('reference 0 is not an object');
    },
  );

  it.each(
    ['consumer', 'reference', 'subject'].flatMap((field) =>
      [undefined, null, '', '  ', 7].map((value) => [field, value]),
    ),
  )('requires a nonempty reference field %s (%#)', (field, value) => {
    expect(() =>
      readMigrationReportFile(
        file({
          references: [{ ...wire, [field as string]: value }],
          collisions: [],
          missing: [],
        }),
      ),
    ).toThrow(`needs a non-empty ${field}`);
  });

  it.each([null, '', '  ', 7, [], {}].map((value) => [value]))(
    'rejects malformed canonical principal claims (%#)',
    (value) => {
      expect(() =>
        readMigrationReportFile(
          file({
            references: [{ ...wire, principal_id: value }],
            collisions: [],
            missing: [],
          }),
        ),
      ).toThrow('invalid principal_id');
    },
  );

  it.each([null, [], 'collision'].map((value) => [value]))(
    'requires an object collision record (%#)',
    (value) => {
      expect(() =>
        readMigrationReportFile(
          file({ references: [], collisions: [value], missing: [] }),
        ),
      ).toThrow('collision 0 is not an object');
    },
  );

  it.each(
    [undefined, null, [], ['one'], ['one', null], ['one', ' ']].map((value) => [
      value,
    ]),
  )(
    'requires at least two actual principal IDs per collision (%#)',
    (value) => {
      expect(() =>
        readMigrationReportFile(
          file({
            references: [],
            collisions: [
              {
                consumer: 'alcantara',
                reference: 'layout',
                principal_ids: value,
              },
            ],
            missing: [],
          }),
        ),
      ).toThrow('needs at least two principal_ids');
    },
  );

  it('normalizes the producer strings and preserves explicit missing references', () => {
    expect(
      readMigrationReportFile(
        file({
          references: [
            {
              consumer: ' alcantara ',
              reference: ' layout ',
              subject: ' subject ',
              principal_id: ' principal ',
            },
          ],
          collisions: [
            {
              consumer: ' alcantara ',
              reference: ' layout ',
              principal_ids: [' first ', ' second '],
            },
          ],
          missing: [
            {
              consumer: 'alcantara',
              reference: 'missing',
              subject: 'unresolved',
            },
          ],
        }),
      ),
    ).toEqual({
      references: [
        {
          consumer: 'alcantara',
          reference: 'layout',
          subject: 'subject',
          principalId: 'principal',
        },
      ],
      collisions: [
        {
          consumer: 'alcantara',
          reference: 'layout',
          principalIds: ['first', 'second'],
        },
      ],
      missing: [
        {
          consumer: 'alcantara',
          reference: 'missing',
          subject: 'unresolved',
          principalId: null,
        },
      ],
    });
  });

  it('refuses duplicate current inventory, altered subjects, duplicate results and partial reports', () => {
    expect(() => mappingsFromMigrationReport(report(), [row, row])).toThrow(
      'duplicate references',
    );
    const altered = report();
    altered.references[0].subject = 'another-subject';
    expect(() => mappingsFromMigrationReport(altered, [row])).toThrow(
      'subject does not match',
    );
    const duplicate = report();
    duplicate.references.push({ ...reference });
    expect(() => mappingsFromMigrationReport(duplicate, [row])).toThrow(
      'duplicate reference result',
    );
    expect(() =>
      mappingsFromMigrationReport(
        { references: [], collisions: [], missing: [] },
        [row],
      ),
    ).toThrow('does not cover');
  });

  it.each([
    { ...reference, consumer: 'other' as 'alcantara', principalId: null },
    { ...reference },
    { ...reference, subject: 'different', principalId: null },
    { ...reference, reference: 'unknown', principalId: null },
  ])('refuses inconsistent declared missing references (%#)', (missing) => {
    const input = report();
    input.missing = [missing];
    expect(() => mappingsFromMigrationReport(input, [row])).toThrow(
      'missing-reference report is inconsistent',
    );
  });

  it('requires missing-reference declarations to match the unresolved set exactly once', () => {
    const unresolved = { ...reference, principalId: null };
    expect(
      mappingsFromMigrationReport(
        { references: [unresolved], missing: [unresolved], collisions: [] },
        [row],
      ),
    ).toEqual([]);
    expect(() =>
      mappingsFromMigrationReport(
        { references: [unresolved], missing: [], collisions: [] },
        [row],
      ),
    ).toThrow('missing-reference report is inconsistent');
    expect(() =>
      mappingsFromMigrationReport(
        {
          references: [unresolved],
          missing: [unresolved, unresolved],
          collisions: [],
        },
        [row],
      ),
    ).toThrow('missing-reference report is inconsistent');
  });

  it.each(
    [
      [],
      [
        {
          consumer: 'other',
          reference: reference.reference,
          principalIds: ['principal-a', 'principal-b'],
        },
      ],
      [
        {
          consumer: 'alcantara',
          reference: 'unknown',
          principalIds: ['principal-a', 'principal-b'],
        },
      ],
      [
        {
          consumer: 'alcantara',
          reference: reference.reference,
          principalIds: ['principal-a', 'principal-c'],
        },
      ],
      [
        {
          consumer: 'alcantara',
          reference: reference.reference,
          principalIds: ['principal-a', 'principal-a'],
        },
      ],
    ].map((value) => [value]),
  )('refuses omitted or altered collision declarations (%#)', (collisions) => {
    const input = report();
    input.references.push({ ...reference, principalId: 'principal-b' });
    input.collisions = collisions;
    expect(() => mappingsFromMigrationReport(input, [row])).toThrow(
      'collision report is inconsistent',
    );
  });

  function store(conflictingLayout = false) {
    return {
      operatorPreference: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              subject: 'preference-subject',
              deviceClass: 'desktop',
              principalId: null,
            },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      sharedConsoleLayout: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            conflictingLayout
              ? [
                  {
                    id: 'owned-layout',
                    ownerSubject: 'layout-subject',
                    ownerPrincipalId: 'existing-owner',
                  },
                ]
              : [],
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      guestInvitation: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'invitation',
              createdByIdentity: 'invitation-subject',
              createdByPrincipalId: null,
            },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      guestEvent: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'ignored-null', details: null },
          { id: 'ignored-array', details: [] },
        ]),
        updateMany: jest.fn(),
      },
    };
  }

  async function migrationFixture(conflict = false) {
    const transaction = store(conflict);
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (callback: (value: unknown) => Promise<unknown>) =>
          callback(transaction),
      ),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const exported = jest.fn();
    const dependencies = {
      bootstrapDatabase: jest.fn().mockResolvedValue(undefined),
      createPrisma: () => prisma as unknown as PrismaClient,
      error: jest.fn(),
      log: jest.fn(),
      writeReferences: exported,
    };
    expect(
      await runPrincipalMigrationCli(
        ['export', 'captured-by-explicit-fixture-writer'],
        dependencies,
      ),
    ).toBe(0);
    const references = exported.mock.calls[0][1] as {
      consumer: string;
      reference: string;
      subject: string;
    }[];
    const path = file({
      references: references.map((entry) => ({
        ...entry,
        principal_id:
          entry.subject === 'layout-subject'
            ? 'new-owner'
            : `principal-for-${entry.subject}`,
      })),
      collisions: [],
      missing: [],
    });
    return { transaction, prisma, dependencies, references, path };
  }

  it('exports device-scoped preference and invitation identities, then compare-and-sets only missing canonical fields', async () => {
    const { transaction, prisma, dependencies, references, path } =
      await migrationFixture();
    expect(references).toEqual([
      {
        consumer: 'alcantara',
        reference: expect.stringMatching(
          /^OperatorPreference:preference-[a-f0-9]{16}$/,
        ),
        subject: 'preference-subject',
      },
      {
        consumer: 'alcantara',
        reference: 'GuestInvitation:invitation',
        subject: 'invitation-subject',
      },
    ]);
    expect(await runPrincipalMigrationCli(['apply', path], dependencies)).toBe(
      0,
    );
    expect(transaction.operatorPreference.updateMany).toHaveBeenCalledWith({
      data: { principalId: 'principal-for-preference-subject' },
      where: {
        subject: 'preference-subject',
        deviceClass: 'desktop',
        principalId: null,
      },
    });
    expect(transaction.guestInvitation.updateMany).toHaveBeenCalledWith({
      data: { createdByPrincipalId: 'principal-for-invitation-subject' },
      where: {
        id: 'invitation',
        createdByIdentity: 'invitation-subject',
        createdByPrincipalId: null,
      },
    });
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.$disconnect).toHaveBeenCalledTimes(2);
  });

  it('refuses consumer conflicts by default and migrates only clean rows when explicitly permitted', async () => {
    const { transaction, dependencies, path } = await migrationFixture(true);
    expect(await runPrincipalMigrationCli(['apply', path], dependencies)).toBe(
      1,
    );
    expect(dependencies.error).toHaveBeenCalledWith(
      expect.stringContaining('Alcantara conflicts remain'),
    );
    expect(transaction.operatorPreference.updateMany).not.toHaveBeenCalled();
    expect(
      await runPrincipalMigrationCli(
        ['apply', path, '--allow-conflicts'],
        dependencies,
      ),
    ).toBe(0);
    expect(transaction.operatorPreference.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.guestInvitation.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.sharedConsoleLayout.updateMany).not.toHaveBeenCalled();
  });
});
