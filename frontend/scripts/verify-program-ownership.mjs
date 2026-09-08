import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const violations = [];

async function filesBelow(relativeDirectory) {
  const directory = path.join(frontendRoot, relativeDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

for (const forbiddenDirectory of ['app/programs/fifthbell', 'public/fifthbell']) {
  for (const file of await filesBelow(forbiddenDirectory)) {
    violations.push(`${file}: Fifthbell presentation files belong in Brokaw/Cronkite`);
  }
}

for (const sourceFile of await filesBelow('app')) {
  if (!/\.(?:ts|tsx|js|jsx)$/.test(sourceFile)) {
    continue;
  }

  const source = await readFile(path.join(frontendRoot, sourceFile), 'utf8');
  if (/programs\/fifthbell/.test(source)) {
    violations.push(`${sourceFile}: imports the removed Fifthbell renderer tree`);
  }
  if (/\/fifthbell\/(?:audio|images)\//.test(source)) {
    violations.push(`${sourceFile}: references an Alcantara-hosted Fifthbell asset`);
  }
}

const programRoute = await readFile(path.join(frontendRoot, 'app/routes/program.tsx'), 'utf8');
for (const match of programRoute.matchAll(/case\s+['"](fifthbell(?:-[a-z-]+)?)['"]\s*:/g)) {
  violations.push(`app/routes/program.tsx: locally renders Fifthbell component type ${match[1]}`);
}

const routeConfig = await readFile(path.join(frontendRoot, 'app/routes.ts'), 'utf8');
if (routeConfig.includes('song-intro-fixture')) {
  violations.push('app/routes.ts: exposes the removed Fifthbell-only song intro fixture');
}

if (violations.length > 0) {
  console.error('Program ownership verification failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Program ownership verified: Alcantara contains no Fifthbell presentation implementation or assets.');
}
