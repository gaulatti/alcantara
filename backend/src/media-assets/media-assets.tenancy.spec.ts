import { randomUUID } from 'node:crypto';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { noRecorder } from '../operator-change/operator-change-recorder.testing';
import { PrismaService } from '../prisma.service';
import { MediaAssetsService } from './media-assets.service';

// CI's coverage step runs without DATABASE_URL and starts this database; a local run sets DATABASE_URL to its own
// disposable one. Without a database the suite fails rather than passing unrun.
const CI_DATABASE_URL =
  'postgresql://alcantara:alcantara-ci-password@127.0.0.1:5432/alcantara_ci?schema=public';

// The gate for switching media assets and labels to the scoped client
// (gaulatti/alcantara#122): a team's scoped read returns the rows the unscoped
// read holds for that team.
describe('media assets and labels scoped to a team, against Postgres', () => {
  const team = 820_000 + (process.pid % 10_000);
  const other = team + 10_000;
  const permissions = [
    ALCANTARA_PERMISSIONS.media.read,
    ALCANTARA_PERMISSIONS.media.manage,
    ALCANTARA_PERMISSIONS.scene.read,
    ALCANTARA_PERMISSIONS.scene.manage,
  ];
  const mine = { permissions, teamId: team };
  const theirs = { permissions, teamId: other };
  const unscoped = { permissions };
  const search = `gate-${team}-${randomUUID()}`;
  const page = { page: 1, limit: 200, search };
  let prisma: PrismaService;

  const service = () =>
    new MediaAssetsService(
      prisma,
      { recordMediaLabelAssignment: jest.fn() } as never,
      noRecorder(),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL ||= CI_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    const where = { teamId: { in: [team, other] } };
    await prisma?.mediaLabel.deleteMany({ where });
    await prisma?.mediaAsset.deleteMany({ where });
    await prisma?.$disconnect();
  });

  it("creates, reads, labels and removes only the team's assets and labels", async () => {
    const create = (who: typeof mine, name: string) =>
      service().createBackgroundAudio(
        {
          name: `${search} ${name}`,
          sourceUrl: `https://media.test/${randomUUID()}.mp3`,
        },
        who,
      );
    const asset = await create(mine, 'mine');
    const foreign = await create(theirs, 'theirs');
    const label = (await service().createLabel(
      { name: `${search} label` },
      mine,
    ))!;

    const all = (await service().findAll(page, unscoped)).data;
    expect(all).toHaveLength(2);
    await expect(service().findAll(page, mine)).resolves.toMatchObject({
      data: all.filter((row) => row.id === asset.id),
      meta: { total: 1 },
    });
    await expect(
      service().replaceAssetLabels(asset.id, [label.id], mine),
    ).resolves.toMatchObject({ labels: [{ id: label.id }] });
    await expect(service().findLabel(label.id, mine)).resolves.toEqual(
      await service().findLabel(label.id, unscoped),
    );
    await expect(
      service().updateLabel(label.id, { description: 'd' }, mine),
    ).resolves.toMatchObject({ description: 'd' });
    await expect(
      service().replaceLabelAssets(label.id, [foreign.id], mine),
    ).rejects.toThrow('Unknown assets');
    await expect(
      service().replaceLabelAssets(label.id, [asset.id], mine),
    ).resolves.toMatchObject({ assetCount: 1 });
    await expect(service().findLabels(page, theirs)).resolves.toMatchObject({
      data: [],
    });

    for (const call of [
      () => service().findOne(foreign.id, mine),
      () => service().removeStandaloneAsset(foreign.id, mine),
      () => service().findLabel(label.id, theirs),
      () => service().removeLabel(label.id, theirs),
    ]) {
      await expect(call()).rejects.toThrow('not found');
    }
    await expect(service().removeLabel(label.id, mine)).resolves.toEqual({
      deletedMediaLabelId: label.id,
    });
    await expect(
      service().removeStandaloneAsset(asset.id, mine),
    ).resolves.toEqual({ deletedMediaAssetId: asset.id });
    await expect(service().findOne(foreign.id, theirs)).resolves.toMatchObject({
      id: foreign.id,
    });
  });
});
