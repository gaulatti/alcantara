// Runs the frontend's coverage suite once and exits with its code. The vitest 3.2.7 worker RPC
// timeout retry (#623) is gone: vitest 4.1.12 (#736) showed 0 timeouts across three Verify runs.
// The verify step can call `pnpm --dir frontend run test:coverage` directly once ci.yml is next edited.
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['--dir', 'frontend', 'run', 'test:coverage'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
