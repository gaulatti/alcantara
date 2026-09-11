import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPostgresAdapter } from '../src/prisma-adapter';

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(process.env.DATABASE_URL),
});

async function main() {
  console.log('Seeding database...');

  await prisma.broadcastSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
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

  const mainProgram = await prisma.programState.upsert({
    where: { programId: 'main' },
    update: { type: 'both', audioMixer: defaultAudioMixer as any },
    create: {
      programId: 'main',
      type: 'both',
      activeSceneId: null,
      audioMixer: defaultAudioMixer as any,
    },
  });

  const tvProgram = await prisma.programState.upsert({
    where: { programId: 'tv-demo' },
    update: { type: 'tv', audioMixer: defaultAudioMixer as any },
    create: {
      programId: 'tv-demo',
      type: 'tv',
      audioMixer: defaultAudioMixer as any,
    },
  });

  const radioProgram = await prisma.programState.upsert({
    where: { programId: 'radio-demo' },
    update: { type: 'radio', audioMixer: defaultAudioMixer as any },
    create: {
      programId: 'radio-demo',
      type: 'radio',
      audioMixer: defaultAudioMixer as any,
    },
  });

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
      update: {},
      create: destination,
    });
  }

  const assignedIntro = await prisma.instant.upsert({
    where: { id: 9001 },
    update: {
      name: 'Local demo song intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.72,
      enabled: true,
      position: 9001,
    },
    create: {
      id: 9001,
      name: 'Local demo song intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.72,
      enabled: true,
      position: 9001,
    },
  });
  await prisma.instant.upsert({
    where: { id: 9002 },
    update: {
      name: 'Local available voice recording',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      volume: 0.9,
      enabled: true,
      position: 9002,
    },
    create: {
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
      artist: 'Seed Artist',
      title: 'Song with recorded intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
    create: {
      id: 9001,
      artist: 'Seed Artist',
      title: 'Song with recorded intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
  });
  await prisma.song.upsert({
    where: { id: 9002 },
    update: {
      artist: 'Seed Artist',
      title: 'Song without intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
    create: {
      id: 9002,
      artist: 'Seed Artist',
      title: 'Song without intro',
      audioUrl: '/fifthbell/audio/pipes.ogg',
      enabled: true,
    },
  });
  await prisma.songIntro.upsert({
    where: { songId: assignedSong.id },
    update: { instantId: assignedIntro.id, programId: 'main' },
    create: {
      songId: assignedSong.id,
      instantId: assignedIntro.id,
      programId: 'main',
    },
  });

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
  await Promise.all(
    [mainProgram.id, radioProgram.id].map((id) =>
      prisma.programState.update({
        where: { id },
        data: { songSequence: songSequence as any },
      }),
    ),
  );

  const demoLayout = await prisma.layout.upsert({
    where: { name: 'Local operator demo' },
    update: {
      componentType: 'full-screen',
      settings: '{}',
    },
    create: {
      id: 9001,
      name: 'Local operator demo',
      componentType: 'full-screen',
      settings: '{}',
    },
  });
  const previewScene = await prisma.scene.upsert({
    where: { id: 9001 },
    update: {
      name: 'Local preview headlines',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PREVIEW · LOCAL REHEARSAL' },
      }),
    },
    create: {
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
      name: 'Local program desk',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PROGRAM · LOCAL REHEARSAL' },
      }),
    },
    create: {
      id: 9002,
      name: 'Local program desk',
      layoutId: demoLayout.id,
      metadata: JSON.stringify({
        'full-screen': { text: 'PROGRAM · LOCAL REHEARSAL' },
      }),
    },
  });
  for (const programStateId of [mainProgram.id, tvProgram.id]) {
    await prisma.programScene.upsert({
      where: {
        programStateId_sceneId: {
          programStateId,
          sceneId: previewScene.id,
        },
      },
      update: { position: 9001 },
      create: { programStateId, sceneId: previewScene.id, position: 9001 },
    });
    await prisma.programScene.upsert({
      where: {
        programStateId_sceneId: {
          programStateId,
          sceneId: programScene.id,
        },
      },
      update: { position: 9002 },
      create: { programStateId, sceneId: programScene.id, position: 9002 },
    });
    await prisma.programState.update({
      where: { id: programStateId },
      data: {
        activeSceneId: programScene.id,
        stagedSceneId: previewScene.id,
        fadeToBlack: false,
      },
    });
  }

  const localMedia = await prisma.media.upsert({
    where: { id: 9001 },
    update: {
      name: 'Local New York still',
      imageUrl: '/fifthbell/images/nyc.jpg',
    },
    create: {
      id: 9001,
      name: 'Local New York still',
      imageUrl: '/fifthbell/images/nyc.jpg',
    },
  });
  const localMediaGroup = await prisma.mediaGroup.upsert({
    where: { name: 'Local city stills' },
    update: { description: 'Fictional assets for local UI verification.' },
    create: {
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
      name: 'Local rehearsal transition',
      videoUrl: '/fifthbell/video/local-transition.webm',
      cutPointMs: 700,
      enabled: false,
    },
    create: {
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
    await prisma.radioSettings.upsert({
      where: { programStateId: programState.id },
      update: {
        palazzoUrl: 'http://palazzo:3100',
        bumperEnabled: true,
        bumperInterval: 3,
        bumperInstantIds: [9002],
        bumperMode: 'sequential',
        enabled: false,
      },
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
      update: { items: definition.items as any, loop: false },
      create: {
        programStateId: definition.program.id,
        name: definition.name,
        items: definition.items as any,
        loop: false,
      },
    });
    await prisma.programState.update({
      where: { id: definition.program.id },
      data: { activeFlightSequenceId: sequence.id },
    });
  }

  const seededProfiles = [
    ['test:alcantara:operator-a', 'desktop', 'director', false, true, 340],
    ['test:alcantara:operator-a', 'tablet', 'compact', true, false, 300],
    ['test:alcantara:operator-a', 'phone', 'compact', true, false, null],
    ['test:alcantara:operator-b', 'desktop', 'audio', false, true, 360],
    ['test:alcantara:viewer', 'desktop', 'director', false, true, 320],
  ] as const;
  for (const [subject, deviceClass, workspace, touchMode, shortcutsEnabled, dockWidth] of seededProfiles) {
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
      update: { version: 1, profile },
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

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
