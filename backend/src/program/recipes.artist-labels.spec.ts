import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArtistLabelsService } from '../artist-labels/artist-labels.service';
import { PompeiiService } from '../auth/pompeii.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';
import {
  ARTIST_LABEL_LOOKUP,
  type ArtistLabelLookup,
} from './artist-label-lookup';
import { FlightService } from './flight.service';
import { ProgramModule } from './program.module';
import { ProgramService } from './program.service';
import { RecipesService } from './recipes.service';

// gaulatti/alcantara#427: the integrator. In the real program module, the song recipe finds the
// artist's label through #423's ArtistLabelsService, so a use of a labelled artist needs no label of
// its own and reports no artist_label_missing.

@Global()
@Module({
  providers: [
    {
      provide: ManagedMetricsService,
      useValue: { recordRecipeExpansion: jest.fn() },
    },
    { provide: PompeiiService, useValue: { teamId: 7 } },
    RealtimeTicketService,
  ],
  exports: [ManagedMetricsService, PompeiiService, RealtimeTicketService],
})
class GlobalStubs {}

const RECIPE = {
  id: 7,
  programStateId: 1,
  name: 'Song',
  revision: 1,
  bumperSceneId: 11,
  slideshowSceneId: 12,
  returnSceneId: null,
  transitionId: 'cut',
  holdMs: 0,
  steps: ['bumperPoint', 'song', 'slideshowPoint'],
};

// gaulatti/alcantara#464, the production shape: a catalog song has no team (null), the link was
// written under the caller's team, and the program row carries that team. The lookup must resolve
// under the program's team, never the song's.
function prismaWith(
  songTeamId: number | null,
  programTeamId: number | null = songTeamId,
  linkTeamId: number | null = programTeamId,
) {
  return {
    program: {
      findUnique: jest.fn(async () => ({ teamId: programTeamId })),
    },
    programState: {
      findUnique: jest.fn(async () => ({ id: 1, programId: 'tv', type: 'tv' })),
    },
    rundownRecipe: { findFirst: jest.fn(async () => RECIPE) },
    song: {
      findUnique: jest.fn(async () => ({
        id: 42,
        artist: ' Fictional Artist ',
        title: 'Fictional Song',
        enabled: true,
        audioUrl: 'https://media.example.test/a.mp3',
        teamId: songTeamId,
      })),
    },
    artistLabel: {
      findFirst: jest.fn(
        async ({ where }: { where: { teamId: number | null } }) =>
          where.teamId === linkTeamId ? { labelId: 'artist-label' } : null,
      ),
    },
    mediaAssetLabel: { count: jest.fn(async () => 3) },
    scene: {
      findUnique: jest.fn(async ({ where }: { where: { id: number } }) => ({
        name: 'scene',
        layout: {
          componentType: where.id === 12 ? 'slideshow' : 'artist-bumper',
        },
        programScenes: [{ programStateId: 1 }],
      })),
    },
  };
}

async function compile(prisma: ReturnType<typeof prismaWith>) {
  return Test.createTestingModule({ imports: [GlobalStubs, ProgramModule] })
    .overrideProvider(ProgramService)
    .useValue({ addEventListener: jest.fn(() => jest.fn()) })
    .overrideProvider(FlightService)
    .useValue({})
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
}

describe('the song recipe reads artist labels (gaulatti/alcantara#427)', () => {
  it("points the bumper and the slideshow at the artist's label, with no issue", async () => {
    const prisma = prismaWith(5);
    const moduleRef = await compile(prisma);
    const { items, issues } = await moduleRef
      .get(RecipesService)
      .expand('tv', 7, { params: { songId: 42 } });
    expect(issues).toEqual([]);
    expect(items[0].metadataPatch).toEqual({
      'artist-bumper': {
        artist: ' Fictional Artist ',
        songTitle: 'Fictional Song',
        labelId: 'artist-label',
      },
    });
    expect(items[2].metadataPatch).toEqual({
      slideshow: { labelId: 'artist-label' },
    });
    expect(prisma.artistLabel.findFirst).toHaveBeenCalledWith({
      where: { teamId: 5, artistKey: 'fictional artist' },
      select: { labelId: true },
    });
    expect(moduleRef.get(ARTIST_LABEL_LOOKUP)).not.toBe(
      moduleRef.get(ArtistLabelsService),
    );
    await moduleRef.close();
  });

  it("finds the label of a song with no team under the program's team, where the link was written", async () => {
    const prisma = prismaWith(null, 5, 5);
    const moduleRef = await compile(prisma);
    const { items, issues } = await moduleRef
      .get(RecipesService)
      .expand('tv', 7, { params: { songId: 42 } });
    expect(issues).toEqual([]);
    expect(items[2].metadataPatch).toEqual({
      slideshow: { labelId: 'artist-label' },
    });
    expect(prisma.artistLabel.findFirst).toHaveBeenCalledWith({
      where: { teamId: 5, artistKey: 'fictional artist' },
      select: { labelId: true },
    });
    await moduleRef.close();
  });

  it('finds the label of a program with no Program row (made before #335) under the asking team, and none without one', async () => {
    const prisma = prismaWith(null, 5, 5);
    prisma.program.findUnique.mockResolvedValue(null as never);
    const moduleRef = await compile(prisma);
    const service = moduleRef.get(RecipesService);
    const asked = await service.expand('tv', 7, { params: { songId: 42 } }, 5);
    expect(asked.issues).toEqual([]);
    const alone = await service.expand('tv', 7, { params: { songId: 42 } });
    expect(alone.issues.map((issue) => issue.code)).toContain(
      'artist_label_missing',
    );
    const foreign = await service.expand(
      'tv',
      7,
      { params: { songId: 42 } },
      9,
    );
    expect(foreign.issues.map((issue) => issue.code)).toContain(
      'artist_label_missing',
    );
    await moduleRef.close();
  });

  it("does not use another team's link for the program", async () => {
    const prisma = prismaWith(null, 5, 9);
    const moduleRef = await compile(prisma);
    const { issues } = await moduleRef
      .get(RecipesService)
      .expand('tv', 7, { params: { songId: 42 } });
    expect(issues.map((issue) => issue.code)).toContain('artist_label_missing');
    await moduleRef.close();
  });

  it("looks a song with no team up as the deployment's own (team 0 in the labels service)", async () => {
    const prisma = prismaWith(null);
    const moduleRef = await compile(prisma);
    const lookup = moduleRef.get<ArtistLabelLookup>(ARTIST_LABEL_LOOKUP);
    await expect(lookup.artistLabelFor(null, 'Fictional Artist')).resolves.toBe(
      'artist-label',
    );
    expect(prisma.artistLabel.findFirst).toHaveBeenCalledWith({
      where: { teamId: null, artistKey: 'fictional artist' },
      select: { labelId: true },
    });
    await moduleRef.close();
  });
});
