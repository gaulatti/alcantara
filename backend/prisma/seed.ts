import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter } from '../src/prisma-adapter';
import {
  DEMO_SONG_IDS,
  demoAudioClient,
  seedDemoAudio,
} from '../src/seed/demo-audio';
import {
  syncAudioClipAsset,
  syncImageAsset,
  syncSongAsset,
  syncTransitionAsset,
} from '../src/media-assets/media-asset-sync';

type SeedEnvironment = Readonly<Record<string, string | undefined>>;
type DemoAudioSender = Parameters<typeof seedDemoAudio>[1];

/**
 * The local stack's seed. Exported so a test can run it against a disposable database with a fake media store; run
 * directly (pnpm seed in Compose) it uses this process's environment and the local media store.
 */
export async function seedLocalDatabase(
  prisma: PrismaClient,
  environment: SeedEnvironment = process.env,
  audio: DemoAudioSender = demoAudioClient(environment),
): Promise<void> {
  console.log('Seeding database...');

  // gaulatti/alcantara#122 and the airing walk's W2: song, media and scene reads go through the caller's team, and the
  // local backend runs with POMPEII_TEAM_ID set, so every seeded library row belongs to that team (none when the
  // variable is unset, the no-tenancy installation). Updates write it too, so a reseed repairs an older local stack.
  const seedTeamId = Number(environment.POMPEII_TEAM_ID) || null;
  const team = { teamId: seedTeamId };

  await prisma.broadcastSettings.upsert({
    where: { id: 1 },
    update: { ...team },
    create: {
      ...team,
      id: 1,
      timeOverrideEnabled: false,
    },
  });

  const defaultAudioMixer = {
    mainMasterVolume: 1,
    songMasterVolume: 1,
    instantMasterVolume: 1,
    sceneInstantMasterVolume: 1,
    streamMasterVolume: 1,
    songMuted: false,
    instantMuted: false,
    sceneInstantMuted: false,
    streamMuted: false,
    songSolo: false,
    instantSolo: false,
    sceneInstantSolo: false,
    streamSolo: false,
    mixerChannels: [
      { id: 'song', name: 'Song', volume: 1, muted: false, solo: false },
      { id: 'stream', name: 'Stream', volume: 1, muted: false, solo: false },
      {
        id: 'instants',
        name: 'Instants',
        volume: 1,
        muted: false,
        solo: false,
      },
      {
        id: 'sceneInstant',
        name: 'Scene Instant',
        volume: 1,
        muted: false,
        solo: false,
      },
    ],
  };

  // Compose re-runs this seed on every backend start. What an operator changed (rotations, show type, mixer, the
  // on-air scene, the log pointer) is written only when the show is created by this run, never on a re-run: a
  // show taken off air must not come back with a scene on air (Yakko's #800 review).
  const existingShows = new Set(
    (
      await prisma.programState.findMany({
        where: { programId: { in: ['main', 'tv-demo', 'radio-demo'] } },
        select: { programId: true },
      })
    ).map((row) => row.programId),
  );
  const isNewShow = (programId: string) => !existingShows.has(programId);

  const mainProgram = await prisma.programState.upsert({
    where: { programId: 'main' },
    update: {},
    create: {
      programId: 'main',
      type: 'both',
      activeSceneId: null,
      audioMixer: defaultAudioMixer as any,
    },
  });

  const tvProgram = await prisma.programState.upsert({
    where: { programId: 'tv-demo' },
    update: {},
    create: {
      programId: 'tv-demo',
      type: 'tv',
      audioMixer: defaultAudioMixer as any,
    },
  });

  const radioProgram = await prisma.programState.upsert({
    where: { programId: 'radio-demo' },
    update: {},
    create: {
      programId: 'radio-demo',
      type: 'radio',
      audioMixer: defaultAudioMixer as any,
    },
  });

  // Each seeded show is registered with the local team, as a show created in the Shows admin is: the program's
  // song reads (Check, logs, recipes) resolve the team from this row, and a show without one reads no songs.
  for (const programId of ['main', 'tv-demo', 'radio-demo']) {
    await prisma.program.upsert({
      where: { programId },
      update: { ...team },
      create: { programId, ...team },
    });
  }

  const localDestinations = [
    {
      id: 'primary',
      displayName: 'Primary rehearsal destination',
      secretId: 'broadcast/local/primary',
      secretVersionId: 'fictional-version-1',
      position: 0,
    },
    {
      id: 'secondary',
      displayName: 'Secondary rehearsal destination',
      secretId: 'broadcast/local/secondary',
      secretVersionId: 'fictional-version-1',
      position: 1,
    },
  ];
  for (const destination of localDestinations) {
    await prisma.broadcastDestination.upsert({
      where: { id: destination.id },
      update: { ...team },
      create: { ...destination, ...team },
    });
  }

  const assignedIntro = await prisma.instant.upsert({
    where: { id: 9001 },
    update: {
      ...team,
      name: 'Local demo song intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.72,
      enabled: true,
      position: 9001,
    },
    create: {
      ...team,
      id: 9001,
      name: 'Local demo song intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.72,
      enabled: true,
      position: 9001,
    },
  });
  const availableIntro = await prisma.instant.upsert({
    where: { id: 9002 },
    update: {
      ...team,
      name: 'Local available voice recording',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.9,
      enabled: true,
      position: 9002,
    },
    create: {
      ...team,
      id: 9002,
      name: 'Local available voice recording',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.9,
      enabled: true,
      position: 9002,
    },
  });

  const assignedSong = await prisma.song.upsert({
    where: { id: 9001 },
    update: {
      ...team,
      artist: 'Seed Artist',
      title: 'Song with recorded intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
    create: {
      ...team,
      id: 9001,
      artist: 'Seed Artist',
      title: 'Song with recorded intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
  });
  const availableSong = await prisma.song.upsert({
    where: { id: 9002 },
    update: {
      ...team,
      artist: 'Seed Artist',
      title: 'Song without intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
    create: {
      ...team,
      id: 9002,
      artist: 'Seed Artist',
      title: 'Song without intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
  });
  // Local demo songs for a recovery playlist and a filler (gaulatti/alcantara#206): each has its own fictional tone
  // uploaded to the Compose localstack, so each download comes from the local media store under its own URL. The seeded
  // songs above keep their existing audio.
  const demoAudioUrls = await seedDemoAudio(environment, audio);
  const demoAudioUrlFor = (id: number): string => {
    const url = demoAudioUrls.get(id);
    if (!url) throw new Error(`no uploaded demo audio for song ${id}`);
    return url;
  };
  for (const [index, id] of DEMO_SONG_IDS.entries()) {
    const demoSong = {
      artist: 'Seed Artist',
      title: `Local demo tone ${index + 1}`,
      audioUrl: demoAudioUrlFor(id),
      enabled: true,
    };
    const song = await prisma.song.upsert({
      where: { id },
      update: { ...demoSong, ...team },
      create: { ...team, id, ...demoSong },
    });
    await syncSongAsset(prisma, song);
  }
  await prisma.songIntro.upsert({
    where: { songId: assignedSong.id },
    update: { instantId: assignedIntro.id, programId: 'main' },
    create: {
      songId: assignedSong.id,
      instantId: assignedIntro.id,
      programId: 'main',
    },
  });

  // Fictional tags exercise the normal Library -> generated log path offline.
  const demoMusicTag = await prisma.mediaLabel.upsert({
    where: { name: 'Demo music' },
    update: { ...team },
    create: {
      ...team,
      id: 'seed:demo-music',
      name: 'Demo music',
      description: 'Fictional local radio pool',
    },
  });
  for (const [position, song] of [assignedSong, availableSong].entries()) {
    await syncSongAsset(prisma, song);
    const linkedSong = await prisma.song.findUniqueOrThrow({
      where: { id: song.id },
      select: { assetId: true },
    });
    await prisma.mediaAssetLabel.upsert({
      where: {
        labelId_assetId: {
          labelId: demoMusicTag.id,
          assetId: linkedSong.assetId!,
        },
      },
      update: {},
      create: {
        labelId: demoMusicTag.id,
        assetId: linkedSong.assetId!,
        position,
      },
    });
  }

  // One fictional artist linked to a seeded label, to exercise the artist label picker offline. The
  // link belongs to the team the local stack is configured for (none when the variable is unset).
  if (
    !(await prisma.artistLabel.findFirst({
      where: { artistKey: 'seed artist', teamId: seedTeamId },
    }))
  ) {
    await prisma.artistLabel.create({
      data: {
        artistKey: 'seed artist',
        teamId: seedTeamId,
        artist: 'Seed Artist',
        labelId: demoMusicTag.id,
      },
    });
  }

  const songSequence = {
    mode: 'manual',
    items: [
      {
        id: 'seed-song-9001',
        kind: 'preset',
        songId: 9001,
        artist: 'Seed Artist',
        title: 'Song with recorded intro',
        coverUrl: '/cover.jpg',
        audioUrl: '/fifthbell/audio/pipes.ogg',
      },
      {
        id: 'seed-song-9002',
        kind: 'preset',
        songId: 9002,
        artist: 'Seed Artist',
        title: 'Song without intro',
        coverUrl: '/cover.jpg',
        audioUrl: '/fifthbell/audio/pipes.ogg',
      },
    ],
    activeItemId: 'seed-song-9001',
    intervalMs: 0,
    loop: false,
    startedAt: 0,
  };
  // The radio-demo program plays the demo songs, which have no intro. The seeded song 9001 keeps its intro on main
  // (a song has one intro, and that intro belongs to main), so radio-demo must not play it: its intro would belong
  // to another program and the strip would read "Intro unavailable".
  const radioSongSequence = {
    mode: 'manual',
    items: DEMO_SONG_IDS.map((id, index) => ({
      id: `seed-song-${id}`,
      kind: 'preset',
      songId: id,
      artist: 'Seed Artist',
      title: `Local demo tone ${index + 1}`,
      coverUrl: '/cover.jpg',
      audioUrl: demoAudioUrlFor(id),
    })),
    activeItemId: `seed-song-${DEMO_SONG_IDS[0]}`,
    intervalMs: 0,
    // The radio show's 24/7 rotation loops. Written only when the show is created (see isNewShow), so an existing
    // local database keeps whatever Loop its operator set.
    loop: true,
    startedAt: 0,
  };
  if (isNewShow('main')) {
    await prisma.programState.update({
      where: { id: mainProgram.id },
      data: { songSequence: songSequence as any },
    });
  }
  if (isNewShow('radio-demo')) {
    await prisma.programState.update({
      where: { id: radioProgram.id },
      data: { songSequence: radioSongSequence as any },
    });
  }

  const demoLayout = await prisma.layout.upsert({
    where: { name: 'Local operator demo' },
    update: {
      ...team,
      componentType: 'full-screen',
      settings: '{}',
    },
    create: {
      ...team,
      id: 9001,
      name: 'Local operator demo',
      componentType: 'full-screen',
      settings: '{}',
    },
  });
  const previewScene = await prisma.scene.upsert({
    where: { id: 9001 },
    update: {
      ...team,
      name: 'Local preview headlines',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PREVIEW · LOCAL REHEARSAL' },
      }),
    },
    create: {
      ...team,
      id: 9001,
      name: 'Local preview headlines',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PREVIEW · LOCAL REHEARSAL' },
      }),
    },
  });
  const programScene = await prisma.scene.upsert({
    where: { id: 9002 },
    update: {
      ...team,
      name: 'Local program desk',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PROGRAM · LOCAL REHEARSAL' },
      }),
    },
    create: {
      ...team,
      id: 9002,
      name: 'Local program desk',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PROGRAM · LOCAL REHEARSAL' },
      }),
    },
  });
  for (const program of [mainProgram, tvProgram]) {
    const programStateId = program.id;
    await prisma.programScene.upsert({
      where: {
        programStateId_sceneId: {
          programStateId,
          sceneId: previewScene.id,
        },
      },
      update: {},
      create: { programStateId, sceneId: previewScene.id, position: 9001 },
    });
    await prisma.programScene.upsert({
      where: {
        programStateId_sceneId: {
          programStateId,
          sceneId: programScene.id,
        },
      },
      update: {},
      create: { programStateId, sceneId: programScene.id, position: 9002 },
    });
    if (isNewShow(program.programId)) {
      await prisma.programState.update({
        where: { id: programStateId },
        data: {
          activeSceneId: programScene.id,
          stagedSceneId: previewScene.id,
          fadeToBlack: false,
        },
      });
    }
  }

  const localMedia = await prisma.media.upsert({
    where: { id: 9001 },
    update: {
      ...team,
      name: 'Local New York still',
      imageUrl: '/fifthbell/images/nyc.jpg',
    },
    create: {
      ...team,
      id: 9001,
      name: 'Local New York still',
      imageUrl: '/fifthbell/images/nyc.jpg',
    },
  });
  const localMediaGroup = await prisma.mediaGroup.upsert({
    where: { name: 'Local city stills' },
    update: { ...team, description: 'Fictional assets for local UI verification.' },
    create: {
      ...team,
      id: 9001,
      name: 'Local city stills',
      description: 'Fictional assets for local UI verification.',
    },
  });
  await prisma.mediaGroupItem.upsert({
    where: {
      mediaGroupId_mediaId: {
        mediaGroupId: localMediaGroup.id,
        mediaId: localMedia.id,
      },
    },
    update: { position: 9001 },
    create: {
      mediaGroupId: localMediaGroup.id,
      mediaId: localMedia.id,
      position: 9001,
    },
  });
  for (const programStateId of [mainProgram.id, tvProgram.id]) {
    await prisma.programMediaGroup.upsert({
      where: {
        programStateId_mediaGroupId: {
          programStateId,
          mediaGroupId: localMediaGroup.id,
        },
      },
      update: { position: 9001 },
      create: {
        programStateId,
        mediaGroupId: localMediaGroup.id,
        position: 9001,
      },
    });
  }

  const localTransition = await prisma.stinger.upsert({
    where: { id: 9001 },
    update: {
      ...team,
      name: 'Local rehearsal transition',
      videoUrl: '/fifthbell/video/local-transition.webm',
      cutPointMs: 700,
      enabled: false,
    },
    create: {
      ...team,
      id: 9001,
      name: 'Local rehearsal transition',
      videoUrl: '/fifthbell/video/local-transition.webm',
      cutPointMs: 700,
      enabled: false,
    },
  });
  for (const programStateId of [mainProgram.id, tvProgram.id]) {
    await prisma.programStinger.upsert({
      where: {
        programStateId_stingerId: {
          programStateId,
          stingerId: localTransition.id,
        },
      },
      update: { position: 9001 },
      create: {
        programStateId,
        stingerId: localTransition.id,
        position: 9001,
      },
    });
  }

  for (const programState of [mainProgram, radioProgram]) {
    // Created when missing, never reset: an operator's local radio settings (automation turned on, the Palazzo
    // address) survive the re-seed that runs on every backend start (the recovery walk).
    await prisma.radioSettings.upsert({
      where: { programStateId: programState.id },
      update: {},
      create: {
        programStateId: programState.id,
        palazzoUrl: 'http://palazzo:3100',
        bumperEnabled: true,
        bumperInterval: 3,
        bumperInstantIds: [9002],
        bumperMode: 'sequential',
        enabled: false,
      },
    });
    await prisma.nowPlayingConsumer.upsert({
      where: {
        programStateId_name: {
          programStateId: programState.id,
          name: 'Local disabled example',
        },
      },
      update: {
        url: 'http://now-playing.test.local/hook',
        method: 'POST',
        headers: {},
        enabled: false,
        position: 9001,
      },
      create: {
        programStateId: programState.id,
        name: 'Local disabled example',
        url: 'http://now-playing.test.local/hook',
        method: 'POST',
        headers: {},
        enabled: false,
        position: 9001,
      },
    });
  }

  const rundownDefinitions = [
    {
      program: mainProgram,
      name: 'Local simulcast rehearsal',
      items: [
        {
          id: 'simulcast-scene',
          kind: 'scene',
          sceneId: 9001,
          transitionId: 'cut',
        },
        { id: 'simulcast-song', kind: 'playSong', songId: 9001 },
        { id: 'simulcast-wait', kind: 'waitForSongEnd' },
      ],
    },
    {
      program: tvProgram,
      name: 'Local TV rehearsal',
      items: [
        { id: 'tv-preview', kind: 'scene', sceneId: 9001, transitionId: 'cut' },
        { id: 'tv-program', kind: 'scene', sceneId: 9002, transitionId: 'cut' },
      ],
    },
    {
      program: radioProgram,
      name: 'Local radio rehearsal',
      items: [
        { id: 'radio-song', kind: 'playSong', songId: 9002 },
        { id: 'radio-clip', kind: 'instant', instantId: 9002 },
        { id: 'radio-wait', kind: 'waitForSongEnd' },
      ],
    },
  ] as const;
  for (const definition of rundownDefinitions) {
    const sequence = await prisma.flightSequence.upsert({
      where: {
        programStateId_name: {
          programStateId: definition.program.id,
          name: definition.name,
        },
      },
      update: {},
      create: {
        programStateId: definition.program.id,
        name: definition.name,
        items: definition.items as any,
        loop: false,
      },
    });
    if (isNewShow(definition.program.programId)) {
      await prisma.programState.update({
        where: { id: definition.program.id },
        data: { activeFlightSequenceId: sequence.id },
      });
    }
  }

  const seededProfiles = [
    ['test:alcantara:operator-a', 'desktop', 'director', false, true, 340],
    ['test:alcantara:operator-a', 'tablet', 'compact', true, false, 300],
    ['test:alcantara:operator-a', 'phone', 'compact', true, false, null],
    ['test:alcantara:operator-b', 'desktop', 'audio', false, true, 360],
    ['test:alcantara:viewer', 'desktop', 'director', false, true, 320],
  ] as const;
  for (const [
    subject,
    deviceClass,
    workspace,
    touchMode,
    shortcutsEnabled,
    dockWidth,
  ] of seededProfiles) {
    const profile = {
      workspace,
      ...(dockWidth === null ? {} : { dockWidth }),
      touchMode,
      shortcutsEnabled,
      selectedProgramId: 'main',
      transitions: { main: 'crescendo-prism' },
    };
    await prisma.operatorPreference.upsert({
      where: { subject_deviceClass: { subject, deviceClass } },
      // Created when missing, never reset: a re-seed must not move the operator to another show (the recovery walk).
      update: {},
      create: {
        subject,
        deviceClass,
        profile,
      },
    });
  }
  await prisma.sharedConsoleLayout.upsert({
    where: {
      scope_scopeId_name: {
        scope: 'program',
        scopeId: 'main',
        name: 'Local rehearsal',
      },
    },
    update: {
      ownerSubject: 'test:alcantara:operator-a',
      description: 'Fictional seeded desktop console layout.',
      sourceDeviceClass: 'desktop',
      version: 1,
      retiredAt: null,
      profile: {
        workspace: 'director',
        dockWidth: 380,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: 'main',
        transitions: { main: 'crescendo-prism' },
      },
    },
    create: {
      ownerSubject: 'test:alcantara:operator-a',
      name: 'Local rehearsal',
      description: 'Fictional seeded desktop console layout.',
      scope: 'program',
      scopeId: 'main',
      sourceDeviceClass: 'desktop',
      profile: {
        workspace: 'director',
        dockWidth: 380,
        touchMode: false,
        shortcutsEnabled: true,
        selectedProgramId: 'main',
        transitions: { main: 'crescendo-prism' },
      },
    },
  });

  // gaulatti/alcantara#424: the song recipe on tv-demo. Its bumper and slideshow scenes belong to
  // tv-demo alone, since each use re-points them; it returns to the program desk.
  const recipeScenes: Array<[number, string, string, Record<string, unknown>]> =
    [
      [
        9003,
        'Local artist bumper',
        'modoitaliano-giorgia-artist-bumper',
        {
          'modoitaliano-giorgia-artist-bumper': {
            show: true,
            artist: '',
            songTitle: '',
            labelId: null,
          },
        },
      ],
      [
        9004,
        'Local song slideshow',
        'slideshow',
        {
          slideshow: {
            labelId: null,
            intervalMs: 5000,
            transitionMs: 900,
            fitMode: 'cover',
          },
        },
      ],
    ];
  for (const [id, name, componentType, metadata] of recipeScenes) {
    const layout = await prisma.layout.upsert({
      where: { name },
      update: { ...team, componentType, settings: '{}' },
      create: { ...team, id, name, componentType, settings: '{}' },
    });
    await prisma.scene.upsert({
      where: { id },
      update: { ...team, name, layoutId: layout.id, metadata: JSON.stringify(metadata) },
      create: {
        ...team,
        id,
        name,
        layoutId: layout.id,
        metadata: JSON.stringify(metadata),
      },
    });
    await prisma.programScene.upsert({
      where: {
        programStateId_sceneId: { programStateId: tvProgram.id, sceneId: id },
      },
      update: { position: id },
      create: { programStateId: tvProgram.id, sceneId: id, position: id },
    });
  }
  await prisma.rundownRecipe.upsert({
    where: {
      programStateId_name: { programStateId: tvProgram.id, name: 'Song' },
    },
    update: {},
    create: {
      programStateId: tvProgram.id,
      name: 'Song',
      bumperSceneId: 9003,
      slideshowSceneId: 9004,
      returnSceneId: programScene.id,
      transitionId: 'cut',
      holdMs: 3000,
      steps: [
        'bumperPoint',
        'bumper',
        'hold',
        'song',
        'slideshowPoint',
        'slideshow',
        'songEnd',
        'back',
      ],
    },
  });

  await prisma.$transaction(async (tx) => {
    await syncAudioClipAsset(tx, assignedIntro);
    await syncAudioClipAsset(tx, availableIntro);
    await syncSongAsset(tx, assignedSong);
    await syncSongAsset(tx, availableSong);
    await syncImageAsset(tx, localMedia);
    await syncTransitionAsset(tx, localTransition);
  });

  console.log('Seeding complete!');
}

if (require.main === module) {
  const prisma = new PrismaClient({
    adapter: createPostgresAdapter(process.env.DATABASE_URL),
  });
  seedLocalDatabase(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
