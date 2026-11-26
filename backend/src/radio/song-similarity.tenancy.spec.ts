import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { RadioMetricsService } from './radio-metrics.service';
import { SongSimilarityService } from './song-similarity.service';
import {
  EXPECTED_EMBEDDING_DIMENSION,
  SIMILARITY_MODEL,
} from './song-similarity.utils';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The similarity switch's gate (gaulatti/alcantara#122), through the real service: a program reads and picks only
// its team's songs, all of them, and a program with no team reads none.
describe("similarity scoped to the program's team, against Postgres", () => {
  const team = 860_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const prefix = `sim-gate-${randomUUID()}`;
  const mine = `${prefix}-mine`;
  const orphan = `${prefix}-orphan`;
  const ids: Record<string, number> = {};
  const address = (name: string) => `https://media.test/${prefix}/${name}.mp3`;
  // L2-normalised, as an upload must be.
  const vector = Array.from(
    { length: EXPECTED_EMBEDDING_DIMENSION },
    () => 1 / Math.sqrt(EXPECTED_EMBEDDING_DIMENSION),
  );
  let prisma: PrismaService;
  let metrics: RadioMetricsService;

  const leaf = (name: string) => ({
    leaf: {
      id: `item-${name}`,
      songId: ids[name],
      highRotation: false,
      artist: name,
      title: name,
      coverUrl: '',
      audioUrl: address(name),
      activePathLabels: [],
    },
    blocked: false,
  });

  const service = async () => {
    const similarity = new SongSimilarityService(prisma, metrics, {
      teamId: team,
    } as never);
    await similarity.reloadSettings();
    await similarity.reloadEmbeddings();
    return similarity;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    metrics = new RadioMetricsService();
    for (const [name, owner] of [
      ['current', team],
      ['own', team],
      ['theirs', other],
    ] as const) {
      const song = await prisma.song.create({
        data: {
          artist: `${prefix}-${name}`,
          title: name,
          audioUrl: address(name),
          teamId: owner,
        },
      });
      ids[name] = song.id;
      for (const segment of ['opening', 'closing']) {
        await prisma.$executeRaw`
          INSERT INTO "SongEmbedding"
            ("songId","segment","model","modelVersion","license","windowSeconds","audioSha256","vector","computedAt")
          VALUES (${song.id}, ${segment}, ${SIMILARITY_MODEL.name}, '1', 'test', 30, ${'0'.repeat(64)},
            ${`[${vector.join(',')}]`}::vector, NOW())`;
      }
    }
    for (const [programId, owner] of [
      [mine, team],
      [orphan, null],
    ] as const) {
      await prisma.program.create({ data: { programId, teamId: owner } });
      const state = await prisma.programState.create({
        data: { programId, type: 'radio' },
      });
      await prisma.radioSettings.create({
        data: {
          programStateId: state.id,
          similarityMode: 'on',
          similarityPool: 'catalog',
          similarityThreshold: 0,
        },
      });
      await prisma.similarityDecision.create({
        data: {
          programId,
          mode: 'on',
          outcome: 'selected',
          playedSongId: ids.own,
          proposedSongId: ids.theirs,
          runnerUps: [],
        },
      });
    }
  });

  afterAll(async () => {
    const programId = { in: [mine, orphan] };
    await prisma?.similarityDecision.deleteMany({ where: { programId } });
    await prisma?.programState.deleteMany({ where: { programId } });
    await prisma?.program.deleteMany({ where: { programId } });
    await prisma?.song.deleteMany({
      where: { teamId: { in: [team, other] } },
    });
    await prisma?.$disconnect();
  });

  const pick = async (programId: string, leaves: string[]) => {
    const proposal = (await service()).propose(programId, {
      currentSongId: ids.current,
      currentArtist: 'someone',
      leaves: leaves.map(leaf),
    });
    return proposal.leaf?.songId ?? null;
  };

  it("picks the team's song, from the sequence and from the catalog, never another team's", async () => {
    await expect(pick(mine, ['theirs', 'own'])).resolves.toBe(ids.own);
    // Nothing of the team in the sequence: the catalog supplies one of its own.
    await expect(pick(mine, ['theirs'])).resolves.toBe(ids.own);
    await expect(pick(orphan, ['own', 'theirs'])).resolves.toBeNull();
  });

  it("labels, counts and exports only the team's songs", async () => {
    const similarity = await service();
    const [decision] = await similarity.listDecisions(mine);
    expect(decision.played).toMatchObject({ title: 'own' });
    expect(decision.proposed).toMatchObject({ title: '' });
    await expect(similarity.getCoverage(mine)).resolves.toMatchObject({
      enabledSongs: 2,
      embeddedSongs: 2,
      missingSongs: 0,
    });
    const exported = await similarity.exportSongs(mine, 'catalog', false);
    expect(exported.songs.map((song) => song.songId)).toEqual([
      ids.current,
      ids.own,
    ]);

    const [nothing] = await similarity.listDecisions(orphan);
    expect(nothing.played).toMatchObject({ title: '' });
    await expect(similarity.getCoverage(orphan)).resolves.toMatchObject({
      enabledSongs: 0,
      embeddedSongs: 0,
    });
    await expect(
      similarity.exportSongs(orphan, 'catalog', false),
    ).resolves.toMatchObject({ songs: [] });
  });

  it('counts every refusal and ignores a path it does not know', async () => {
    const counter = new RadioMetricsService();
    const similarity = new SongSimilarityService(prisma, counter, {
      teamId: team,
    } as never);
    await similarity.listDecisions(orphan);
    await similarity.listDecisions(orphan);
    counter.recordSimilarityScopeRefusal('nonsense' as never);
    expect(counter.render()).toMatch(
      /alcantara_similarity_scope_refusals_total\{path="decisions"\} 2/,
    );
    expect(counter.render()).not.toMatch('nonsense');
  });

  it("stores embeddings only for the program's team", async () => {
    const similarity = await service();
    const upload = (name: string) => ({
      schema: 1,
      model: SIMILARITY_MODEL,
      windowSeconds: 30,
      songs: [
        {
          songId: ids[name],
          audioSha256: '1'.repeat(64),
          opening: vector,
          closing: vector,
        },
      ],
    });
    await expect(
      similarity.storeEmbeddings(upload('own'), mine),
    ).resolves.toMatchObject({ results: [{ status: 'stored' }] });
    for (const [name, programId] of [
      ['theirs', mine],
      ['own', orphan],
    ]) {
      await expect(
        similarity.storeEmbeddings(upload(name), programId),
      ).resolves.toMatchObject({
        results: [{ status: 'rejected', reason: 'unknown song' }],
      });
    }
    expect(metrics.render()).toMatch(
      /alcantara_similarity_scope_refusals_total\{path="upload"\} 1/,
    );
  });
});
