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
