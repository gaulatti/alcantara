import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const adapter = new PrismaLibSql({
  url: 'file:./prisma/dev.db',
});

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding database...');

  // Create layouts
  const lowerThirdLayout = await prisma.layout.create({
    data: {
      name: 'Lower Third',
      componentType: 'lower-third',
      settings: JSON.stringify({ position: 'bottom' }),
    },
  });

  const fullScreenLayout = await prisma.layout.create({
    data: {
      name: 'Full Screen',
      componentType: 'full-screen',
      settings: JSON.stringify({}),
    },
  });

  const cornerBugLayout = await prisma.layout.create({
    data: {
      name: 'Corner Bug',
      componentType: 'corner-bug',
      settings: JSON.stringify({ position: 'top-right' }),
    },
  });

  console.log('Created layouts:', {
    lowerThirdLayout,
    fullScreenLayout,
    cornerBugLayout,
  });

  // Create scenes
  const newsScene = await prisma.scene.create({
    data: {
      name: 'Breaking News',
      layoutId: lowerThirdLayout.id,
      chyronText: 'BREAKING NEWS',
      metadata: JSON.stringify({ color: 'red' }),
    },
  });

  const welcomeScene = await prisma.scene.create({
    data: {
      name: 'Welcome',
      layoutId: fullScreenLayout.id,
      chyronText: 'Welcome to the Show',
      metadata: JSON.stringify({ animation: 'fade' }),
    },
  });

  const liveScene = await prisma.scene.create({
    data: {
      name: 'Live Indicator',
      layoutId: cornerBugLayout.id,
      chyronText: 'LIVE',
      metadata: JSON.stringify({ blink: true }),
    },
  });

  console.log('Created scenes:', { newsScene, welcomeScene, liveScene });

  // Initialize program state
  const programState = await prisma.programState.create({
    data: {
      programId: 'main',
      activeSceneId: null,
    },
  });

  console.log('Created program state:', programState);

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
