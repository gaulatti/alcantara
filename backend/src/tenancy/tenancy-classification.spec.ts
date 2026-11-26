import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  readSchemaModels,
  TENANCY_CLASSIFICATION,
  tenancyClassificationProblems,
  type TenancyClass,
} from './tenancy-classification';

// gaulatti/alcantara#149: the tenancy ratchet. It reads the real Prisma schema, so
// a new model cannot be added without deciding who owns its rows.

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');

describe('tenancy classification of the real schema', () => {
  const models = readSchemaModels(readFileSync(SCHEMA_PATH, 'utf8'));

  it('reads every model of backend/prisma/schema.prisma', () => {
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((model) => model.name)).toContain('ExternalSource');
    expect(
      models
        .find((model) => model.name === 'ExternalSource')
        ?.fields.get('teamId'),
    ).toBe('Int');
  });

  it('classifies every model, and only real models, truthfully', () => {
    expect(
      tenancyClassificationProblems(models, TENANCY_CLASSIFICATION),
    ).toEqual([]);
    expect(Object.keys(TENANCY_CLASSIFICATION).sort()).toEqual(
      models.map((model) => model.name).sort(),
    );
  });

  it('reports a tenant table that loses its teamId (#548: no allowance remains)', () => {
    const withoutSceneTeam = models.map((model) =>
      model.name === 'Scene'
        ? {
            ...model,
            fields: new Map(
              [...model.fields].filter(([field]) => field !== 'teamId'),
            ),
          }
        : model,
    );
    expect(
      tenancyClassificationProblems(withoutSceneTeam, TENANCY_CLASSIFICATION),
    ).toEqual(['Model Scene is classified tenant but has no teamId field.']);
  });
});

describe('readSchemaModels', () => {
  it('reads model names and base field types, ignoring comments, attributes, enums and other blocks', () => {
    const schema = `
datasource db {
  provider = "postgresql"
}

enum Kind {
  a
  b
}

// model Commented {
model Show {
  id        Int      @id @default(autoincrement()) // trailing comment
  teamId    Int?
  // programId String
  tags      Tag[]
  @@index([teamId])
}

model Tag {
  id     String @id
  show   Show   @relation(fields: [showId], references: [id])
  showId Int
}
`;

    const models = readSchemaModels(schema);

    expect(models.map((model) => model.name)).toEqual(['Show', 'Tag']);
    expect([...models[0].fields]).toEqual([
      ['id', 'Int'],
      ['teamId', 'Int'],
      ['tags', 'Tag'],
    ]);
    expect([...models[1].fields]).toEqual([
      ['id', 'String'],
      ['show', 'Show'],
      ['showId', 'Int'],
    ]);
  });
});

describe('tenancyClassificationProblems', () => {
  const schema = readSchemaModels(`
model Team {
  id     Int @id
  teamId Int
}

model Library {
  id     Int  @id
  teamId Int?
}

model Episode {
  id        Int    @id
  programId String
}

model Clip {
  id        Int     @id
  episode   Episode @relation(fields: [episodeId], references: [id])
  episodeId Int
}

model Preference {
  id String @id
}
`);
  const classification: Record<string, TenancyClass> = {
    Team: { kind: 'tenant' },
    Library: { kind: 'tenant' },
    Episode: { kind: 'program' },
    Clip: { kind: 'child', parent: 'Episode' },
    Preference: { kind: 'principal' },
  };

  it('accepts a complete and true classification', () => {
    expect(tenancyClassificationProblems(schema, classification)).toEqual([]);
  });

  it('names a model that has no classification', () => {
    const rest = Object.fromEntries(
      Object.entries(classification).filter(([name]) => name !== 'Preference'),
    );

    expect(tenancyClassificationProblems(schema, rest)).toEqual([
      'Model Preference has no tenancy classification.',
    ]);
  });

  it('does not take an inherited property for a classification', () => {
    const models = readSchemaModels('model constructor {\n  id Int @id\n}\n');

    expect(tenancyClassificationProblems(models, {})).toEqual([
      'Model constructor has no tenancy classification.',
    ]);
  });

  it('names a classified model that is not in the schema', () => {
    expect(
      tenancyClassificationProblems(schema, {
        ...classification,
        Ghost: { kind: 'principal' },
      }),
    ).toEqual([
      'Classification names Ghost, which is not a model in the schema.',
    ]);
  });

  it('rejects a tenant without teamId', () => {
    expect(
      tenancyClassificationProblems(schema, {
        ...classification,
        Preference: { kind: 'tenant' },
      }),
    ).toEqual([
      'Model Preference is classified tenant but has no teamId field.',
    ]);
  });

  it('rejects a program model without programId', () => {
    expect(
      tenancyClassificationProblems(schema, {
        ...classification,
        Preference: { kind: 'program' },
      }),
    ).toEqual([
      'Model Preference is classified program but has no programId field.',
    ]);
  });

  it('rejects a child whose parent is not classified', () => {
    expect(
      tenancyClassificationProblems(schema, {
        ...classification,
        Clip: { kind: 'child', parent: 'Season' },
      }),
    ).toEqual(['Model Clip names parent Season, which is not classified.']);
  });

  it('rejects a child with no relation to its parent', () => {
    expect(
      tenancyClassificationProblems(schema, {
        ...classification,
        Clip: { kind: 'child', parent: 'Team' },
      }),
    ).toEqual(['Model Clip names parent Team but has no relation to it.']);
  });
});
