/**
 * Who owns the rows of every Prisma model (gaulatti/alcantara#122, #149).
 *
 * A tenant is a Pompeii team (`teamId`, an integer). Each model has exactly one
 * class:
 * - `tenant`: the model carries its own `teamId`.
 * - `program`: the model carries a `programId` and is owned through the program.
 * - `child`: the model is owned through the named parent model, which it relates to.
 * - `principal`: the model belongs to one person.
 *
 * `tenancy-classification.spec.ts` reads `backend/prisma/schema.prisma` and fails
 * when a model is missing from this map, when the map names a model that does not
 * exist, or when a class does not match the schema. To add a table, add its model
 * here with the class that says who owns its rows.
 */
export type TenancyClass =
  | { kind: 'tenant' }
  | { kind: 'program' }
  | { kind: 'child'; parent: string }
  | { kind: 'principal' };

const tenant: TenancyClass = { kind: 'tenant' };
const program: TenancyClass = { kind: 'program' };
const principal: TenancyClass = { kind: 'principal' };
const childOf = (parent: string): TenancyClass => ({ kind: 'child', parent });

export const TENANCY_CLASSIFICATION: Readonly<Record<string, TenancyClass>> = {
  // Tenant-owned: their own teamId (the shared libraries get it from #148).
  ExternalSource: tenant,
  Layout: tenant,
  Scene: tenant,
  MediaAsset: tenant,
  MediaLabel: tenant,
  Media: tenant,
  MediaGroup: tenant,
  Song: tenant,
  Instant: tenant,
  Stinger: tenant,
  BroadcastDestination: tenant,
  BroadcastSettings: tenant,
  // Audit of ingest-credential requests (gaulatti/carmencita#4): the destination's team.
  // Artist to media label link (gaulatti/alcantara#423): scoped by the caller's team.
  ArtistLabel: tenant,
  BroadcastIngestAccess: tenant,
  // Audit of key set/replace (gaulatti/alcantara#376): the destination's team.
  BroadcastDestinationKeyChange: tenant,
  OperatorChangeRecord: tenant,
  // The program table (gaulatti/alcantara#147): one row per program with its own team.
  Program: tenant,

  // Program-owned: a programId.
  ProgramState: program,
  // Owned through the Program row (its team), gaulatti/alcantara#335.
  ProgramBranding: childOf('Program'),
  BroadcastDestinationSelection: program,
  BroadcastDestinationCommand: program,
  BroadcastDestinationRuntime: program,
  ExternalSourceProgram: program,
  SimilarityDecision: program,
  SongIntro: program,
  GuestInvitation: program,
  AsRunRecord: program,
  // Program fillers (gaulatti/alcantara#126): a programId, no relation.
  FillerVersion: program,
  FillerLeg: program,

  // Owned through a parent.
  MediaAssetLabel: childOf('MediaAsset'),
  BackgroundAudioCapability: childOf('MediaAsset'),
  MediaAssetAnalysis: childOf('MediaAsset'),
  MediaGroupItem: childOf('MediaGroup'),
  SongEmbedding: childOf('Song'),
  SongChartIdentity: childOf('Song'),
  BroadcastDestinationSelectionItem: childOf('BroadcastDestinationSelection'),
  ExternalSourceCredential: childOf('ExternalSource'),
  GuestCommand: childOf('GuestInvitation'),
  GuestEvent: childOf('GuestInvitation'),
  FlightSequence: childOf('ProgramState'),
  RundownRecipe: childOf('ProgramState'),
  ProgramRendererKey: childOf('ProgramState'),
  RadioClock: childOf('ProgramState'),
  RadioDaypartGrid: childOf('ProgramState'),
  RadioDaypart: childOf('RadioDaypartGrid'),
  ProgramScene: childOf('ProgramState'),
  ProgramMediaGroup: childOf('ProgramState'),
  ProgramStinger: childOf('ProgramState'),
  RadioSettings: childOf('ProgramState'),
  RadioBumperPosition: childOf('ProgramState'),
  RadioPlayoutHeard: childOf('ProgramState'),
  NowPlayingConsumer: childOf('ProgramState'),

  // Per person.
  OperatorPreference: principal,
  SharedConsoleLayout: principal,
};

/** A Prisma model as the classification needs it: its fields and their base types. */
export interface SchemaModel {
  name: string;
  fields: ReadonlyMap<string, string>;
}

/** Reads every `model` block of a Prisma schema: field names and base types (without `?` or `[]`). */
export function readSchemaModels(schema: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, string>();
    for (const rawLine of match[2].split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      const field = /^(\w+)\s+(\w+)/.exec(line);
      if (field) fields.set(field[1], field[2]);
    }
    models.push({ name: match[1], fields });
  }
  return models;
}

/**
 * Every way a classification disagrees with the schema's models; empty when it is
 * complete and true. The ratchet calls it with TENANCY_CLASSIFICATION. Every
 * model classified `tenant` must have a `teamId` field: the allowance for the
 * eleven shared libraries ended once #148 gave them one (#548).
 */
export function tenancyClassificationProblems(
  models: readonly SchemaModel[],
  classification: Readonly<Record<string, TenancyClass>>,
): string[] {
  const problems: string[] = [];
  const byName = new Map(models.map((model) => [model.name, model]));
  const classOf = (name: string): TenancyClass | undefined =>
    Object.hasOwn(classification, name) ? classification[name] : undefined;

  for (const model of models) {
    const tenancy = classOf(model.name);
    if (!tenancy) {
      problems.push(`Model ${model.name} has no tenancy classification.`);
      continue;
    }
    if (tenancy.kind === 'tenant' && !model.fields.has('teamId')) {
      problems.push(
        `Model ${model.name} is classified tenant but has no teamId field.`,
      );
    }
    if (tenancy.kind === 'program' && !model.fields.has('programId')) {
      problems.push(
        `Model ${model.name} is classified program but has no programId field.`,
      );
    }
    if (tenancy.kind === 'child') {
      if (!classOf(tenancy.parent)) {
        problems.push(
          `Model ${model.name} names parent ${tenancy.parent}, which is not classified.`,
        );
      } else if (![...model.fields.values()].includes(tenancy.parent)) {
        problems.push(
          `Model ${model.name} names parent ${tenancy.parent} but has no relation to it.`,
        );
      }
    }
  }

  for (const name of Object.keys(classification)) {
    if (!byName.has(name)) {
      problems.push(
        `Classification names ${name}, which is not a model in the schema.`,
      );
    }
  }

  return problems;
}
