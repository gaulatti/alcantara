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

  await prisma.programState.upsert({
    where: { programId: 'main' },
    update: {},
    create: {
      programId: 'main',
      activeSceneId: null,
      audioMixer: {
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
          {
            id: 'stream',
            name: 'Stream',
            volume: 1,
            muted: false,
            solo: false,
          },
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
      } as any,
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

  const seededProfiles = [
    ['test:alcantara:operator-a', 'desktop', 'director', false, true, 340],
    ['test:alcantara:operator-a', 'tablet', 'compact', true, false, 300],
    ['test:alcantara:operator-a', 'phone', 'compact', true, false, null],
    ['test:alcantara:operator-b', 'desktop', 'graphics', false, true, 360],
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
