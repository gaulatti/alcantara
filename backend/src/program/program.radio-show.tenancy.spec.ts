import { PrismaService } from '../prisma.service';
import { ProgramService } from './program.service';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// An audio-only (radio) show must have no template: ProgramState_radio_visual_fields_check requires SQL NULL in
// templateManifest. Writing JSON null there made every radio show fail to create, and every rename or conversion to
// radio fail too, with a 500. These run against Postgres so the real constraint is exercised.
describe('radio shows against Postgres', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ids: string[] = [];
  let prisma: PrismaService;

  const service = () => {
    const program = new (ProgramService as unknown as new (
      db: unknown,
    ) => ProgramService)(prisma);
    (program as unknown as { recorder: unknown }).recorder = noRecorder();
    // Nothing is on air, and there is no radio engine to move on a rename.
    (
      program as unknown as { songExecutionEngine: unknown }
    ).songExecutionEngine = {
      getOnAirView: () => ({ playbackRequestId: null }),
      renameProgram: () => Promise.resolve(),
    };
    jest.spyOn(program, 'broadcastUpdate').mockImplementation(() => undefined);
    return program;
  };
  const id = (name: string) => {
    const value = `${name}-${suffix}`;
    ids.push(value);
    return value;
  };
  const row = (programId: string) =>
    prisma.$queryRaw<{ type: string; manifestIsNull: boolean }[]>`
      SELECT "type", "templateManifest" IS NULL AS "manifestIsNull"
      FROM "ProgramState" WHERE "programId" = ${programId}`;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (ids.length) {
      await prisma.programState.deleteMany({
        where: { programId: { in: ids } },
      });
      await prisma.program.deleteMany({ where: { programId: { in: ids } } });
    }
    await prisma?.$disconnect();
  });

  it('creates a radio show, with no template stored as SQL NULL', async () => {
    const radio = id('radio-new');
    await service().createProgram(radio, 'radio');
    await expect(row(radio)).resolves.toEqual([
      { type: 'radio', manifestIsNull: true },
    ]);
  });

  it('stores no template as SQL NULL for a TV show too', async () => {
    const tv = id('tv-new');
    await service().createProgram(tv, 'tv');
    await expect(row(tv)).resolves.toEqual([
      { type: 'tv', manifestIsNull: true },
    ]);
  });

  it('converts a TV show to radio and renames a radio show', async () => {
    const tv = id('tv-convert');
    await service().createProgram(tv, 'tv');
    await service().renameProgram(tv, tv, 'radio');
    await expect(row(tv)).resolves.toEqual([
      { type: 'radio', manifestIsNull: true },
    ]);

    const renamed = id('radio-renamed');
    await service().renameProgram(tv, renamed);
    await expect(row(renamed)).resolves.toEqual([
      { type: 'radio', manifestIsNull: true },
    ]);
  });
});
