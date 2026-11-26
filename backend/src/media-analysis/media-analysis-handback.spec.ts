import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { MediaAnalysisService } from './media-analysis.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// gaulatti/alcantara#587: a process that dies mid-run, however it dies, leaves a claim; the next one hands it back.
describe('claims left by a stopped process, against Postgres', () => {
  const id = `handback:${randomUUID()}`;
  let prisma: PrismaService;
  const later = new Date('2099-01-01T00:00:00.000Z');
  const now = new Date('2026-11-26T07:00:00.000Z');
  const metrics = { recordInterrupted: jest.fn() };
  const service = () =>
    new MediaAnalysisService(prisma, metrics as never, {} as never);
  const row = () =>
    prisma.mediaAssetAnalysis.findUniqueOrThrow({ where: { assetId: id } });
  // The row as a claim leaves it.
  const claim = (attempts: number) =>
    prisma.mediaAssetAnalysis.update({
      where: { assetId: id },
      data: { attempts, claimedAt: now, nextAttemptAt: later },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.mediaAsset.create({
      data: {
        id,
        mediaType: 'AUDIO',
        name: id,
        sourceUrl: 'https://media.test/handback.mp3',
      },
    });
    await prisma.mediaAssetAnalysis.create({
      data: { assetId: id, status: 'success', cueOutSeconds: 200 },
    });
  });

  afterAll(async () => {
    await prisma?.mediaAsset.deleteMany({ where: { id } });
    await prisma?.$disconnect();
  });

  it('are due again with the attempt returned, and keep the good result; two restarts cost nothing', async () => {
    for (const restart of [1, 2, 3]) {
      await claim(1);
      await service().handBackClaims(now);
      await expect(row()).resolves.toMatchObject({
        attempts: 0,
        interruptions: restart,
        claimedAt: null,
        nextAttemptAt: now,
        status: 'success',
        cueOutSeconds: 200,
      });
    }
    // After the free ones an interruption spends the attempt.
    await claim(1);
    await service().handBackClaims(now);
    await expect(row()).resolves.toMatchObject({
      attempts: 1,
      interruptions: 3,
      claimedAt: null,
      nextAttemptAt: now,
    });
  });

  it('leave a row that no run holds, such as one waiting out a retry, alone', async () => {
    await prisma.mediaAssetAnalysis.update({
      where: { assetId: id },
      data: { claimedAt: null, nextAttemptAt: later, attempts: 2 },
    });
    await service().handBackClaims(now);
    await expect(row()).resolves.toMatchObject({
      attempts: 2,
      nextAttemptAt: later,
    });
  });
});
