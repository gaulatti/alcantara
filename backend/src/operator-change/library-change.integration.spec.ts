import { randomUUID } from 'node:crypto';
import { ActorContext, type Actor } from '../auth/actor-context';
import { MediaAssetsService } from '../media-assets/media-assets.service';
import { MediaGroupsService } from '../media-groups/media-groups.service';
import { MediaService } from '../media/media.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { ProgramService } from '../program/program.service';
import { SongsService } from '../songs/songs.service';
import { StingersService } from '../stingers/stingers.service';
import { OperatorChangeRecorder } from './operator-change-recorder';

/**
 * gaulatti/alcantara#236 slice 3, on PostgreSQL: each of the seven library writes, called through
 * its real service as the MCP capability and the console route call it, stores one operator change
 * record after the change, with programId NULL and teamId NULL; via=mcp records the MCP capability
 * and client, via=console the console route. A record the database refuses never fails the change.
 * Runs when DATABASE_URL names a migrated database.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tag = `e2e-236-${process.pid}-${Date.now()}`;
const mcp: Actor = {
  principalId: `${tag}-mcp`,
  via: 'mcp',
  client: 'fictional-client',
};
const console_: Actor = {
  principalId: `${tag}-console`,
  via: 'console',
  client: null,
};
const all = { permissions: ['*'] };

describeWithDatabase(
  'library changes and their operator change records',
  () => {
    let prisma: PrismaService;
    let programs: ProgramService;
    let stingers: StingersService;
    let songs: SongsService;
    let media: MediaService;
    let assets: MediaAssetsService;
    let groups: MediaGroupsService;
    const created: { model: string; id: number | string }[] = [];

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      const metrics = new ManagedMetricsService();
      const recorder = new OperatorChangeRecorder(prisma, metrics);
      programs = new ProgramService(
        prisma,
        {} as never,
        {} as never,
        metrics,
        {} as never,
        recorder,
      );
      stingers = new StingersService(prisma, recorder);
      songs = new SongsService(prisma, recorder);
      media = new MediaService(prisma, recorder);
      assets = new MediaAssetsService(prisma, metrics, recorder);
      groups = new MediaGroupsService(prisma, recorder);
    });

    afterAll(async () => {
      await prisma.operatorChangeRecord.deleteMany({
        where: { principal: { startsWith: tag } },
      });
      for (const { model, id } of created.reverse()) {
        await (
          prisma as unknown as Record<
            string,
            { deleteMany(args: unknown): Promise<unknown> }
          >
        )[model].deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    });

    const records = () =>
      prisma.operatorChangeRecord.findMany({
        where: { principal: { startsWith: tag } },
        orderBy: { createdAt: 'asc' },
      });

    async function latest() {
      const rows = await records();
      return rows[rows.length - 1];
    }

    it('records an instant change from the MCP with its client, and from the console', async () => {
      const instant = await prisma.instant.create({
        data: {
          name: `${tag} instant`,
          audioUrl: 'https://media.example.test/instant.mp3',
          position: 900_000 + (process.pid % 90_000),
          volume: 0.8,
        },
      });
      created.push({ model: 'instant', id: instant.id });

      await ActorContext.run(mcp, () =>
        programs.updateInstant(instant.id, { volume: 0.4 }),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        teamId: null,
        principal: mcp.principalId,
        via: 'mcp',
        client: 'fictional-client',
        capability: 'instant_update_instant',
        summary: {
          target: { kind: 'instant', id: String(instant.id) },
          changed: ['volume'],
          before: { volume: 0.8 },
          after: { volume: 0.4 },
        },
      });

      await ActorContext.run(console_, () =>
        programs.updateInstant(instant.id, { enabled: false }),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        via: 'console',
        client: null,
        capability: 'instants.update',
        summary: {
          changed: ['enabled'],
          before: { enabled: true },
          after: { enabled: false },
        },
      });
    });

    it('records a stinger change', async () => {
      const stinger = await prisma.stinger.create({
        data: {
          name: `${tag} stinger`,
          videoUrl: 'https://media.example.test/s.webm',
        },
      });
      created.push({ model: 'stinger', id: stinger.id });
      await ActorContext.run(console_, () =>
        stingers.update(stinger.id, { cutPointMs: 600 }),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        capability: 'stingers.update',
        summary: {
          target: { kind: 'stinger', id: String(stinger.id) },
          changed: ['cutPointMs'],
          before: { cutPointMs: 1000 },
          after: { cutPointMs: 600 },
        },
      });
    });

    it('records a song change', async () => {
      const song = await prisma.song.create({
        data: {
          artist: `${tag} artist`,
          title: 'Fictional title',
          audioUrl: 'https://media.example.test/song.mp3',
        },
      });
      created.push({ model: 'song', id: song.id });
      await ActorContext.run(mcp, () =>
        songs.update(
          song.id,
          { enabled: false, title: 'Fictional retitle' },
          0,
        ),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        capability: 'song_update',
        summary: {
          target: { kind: 'song', id: String(song.id) },
          changed: ['title', 'enabled'],
          before: { enabled: true },
          after: { enabled: false },
        },
      });
    });

    it('records a media change, naming the URL without copying it', async () => {
      const item = await prisma.media.create({
        data: {
          name: `${tag} media`,
          imageUrl: 'https://media.example.test/a.png',
        },
      });
      created.push({ model: 'media', id: item.id });
      await ActorContext.run(console_, () =>
        media.update(item.id, { imageUrl: 'https://media.example.test/b.png' }),
      );
      const record = await latest();
      expect(record).toMatchObject({
        programId: null,
        capability: 'media.update',
        summary: {
          target: { kind: 'media', id: String(item.id) },
          changed: ['imageUrl'],
          before: {},
          after: {},
        },
      });
      expect(JSON.stringify(record.summary)).not.toContain(
        'media.example.test',
      );
    });

    it('records a media label change and a label asset replacement', async () => {
      const label = await prisma.mediaLabel.create({
        data: { id: randomUUID(), name: `${tag} label` },
      });
      created.push({ model: 'mediaLabel', id: label.id });
      await ActorContext.run(mcp, () =>
        assets.updateLabel(
          label.id,
          { description: 'Fictional description' },
          all,
        ),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        capability: 'media_asset_update_label',
        summary: {
          target: { kind: 'media_label', id: String(label.id) },
          changed: ['description'],
        },
      });
      expect(JSON.stringify((await latest()).summary)).not.toContain(
        'Fictional description',
      );

      await ActorContext.run(console_, () =>
        assets.replaceLabelAssets(label.id, [], all),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        capability: 'media-assets.replace-label-assets',
        summary: {
          target: { kind: 'media_label_assets', id: String(label.id) },
          changed: ['assetIds'],
          before: { assetIds: 0 },
          after: { assetIds: 0 },
        },
      });
    });

    it('records a media group change, with the size of a replaced media list', async () => {
      const item = await prisma.media.create({
        data: {
          name: `${tag} group media`,
          imageUrl: 'https://media.example.test/c.png',
        },
      });
      created.push({ model: 'media', id: item.id });
      const group = await prisma.mediaGroup.create({
        data: { name: `${tag} group` },
      });
      created.push({ model: 'mediaGroup', id: group.id });

      await ActorContext.run(mcp, () =>
        groups.update(group.id, { mediaIds: [item.id] }),
      );
      expect(await latest()).toMatchObject({
        programId: null,
        capability: 'media_group_update',
        summary: {
          target: { kind: 'media_group', id: String(group.id) },
          changed: ['mediaIds'],
          before: { mediaIds: 0 },
          after: { mediaIds: 1 },
        },
      });

      await ActorContext.run(console_, () =>
        groups.update(group.id, { name: `${tag} group 2` }),
      );
      expect(await latest()).toMatchObject({
        capability: 'media-groups.update',
        summary: { changed: ['name'], before: {}, after: {} },
      });
    });

    it('keeps the change when the database refuses its record', async () => {
      const stinger = await prisma.stinger.create({
        data: {
          name: `${tag} refused`,
          videoUrl: 'https://media.example.test/r.webm',
        },
      });
      created.push({ model: 'stinger', id: stinger.id });
      await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION library_change_refuse() RETURNS trigger AS $$
      BEGIN
        IF NEW."principal" = '${tag}-refused' THEN
          RAISE EXCEPTION 'record write refused by the fixture';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS library_change_refuse ON "OperatorChangeRecord";
       CREATE TRIGGER library_change_refuse BEFORE INSERT ON "OperatorChangeRecord"
       FOR EACH ROW EXECUTE FUNCTION library_change_refuse();`,
      );
      try {
        const before = (await records()).length;
        const updated = await ActorContext.run(
          { principalId: `${tag}-refused`, via: 'mcp', client: null },
          () => stingers.update(stinger.id, { enabled: false }),
        );
        expect(updated.enabled).toBe(false);
        const stored = await prisma.stinger.findUniqueOrThrow({
          where: { id: stinger.id },
        });
        expect(stored.enabled).toBe(false);
        expect(await records()).toHaveLength(before);
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS library_change_refuse ON "OperatorChangeRecord"`,
        );
        await prisma.$executeRawUnsafe(
          `DROP FUNCTION IF EXISTS library_change_refuse()`,
        );
      }
    });
  },
);
