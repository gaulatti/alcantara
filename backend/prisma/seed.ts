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
