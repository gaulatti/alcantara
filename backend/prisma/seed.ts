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
