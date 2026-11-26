// Runs the frontend's coverage suite and retries it once when the only failure is vitest's worker RPC
// timeout ("Timeout calling \"onTaskUpdate\""), with every test file passing and no coverage threshold
// failing. Any other failure fails the step on the first attempt, as before.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TIMEOUT = /Timeout calling "onTaskUpdate"/g;

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// True only when the output shows every test file passing, no coverage threshold failure, and exactly
// one error per worker RPC timeout: the timeout is the only thing that failed.
export function onlyWorkerRpcTimeout(output) {
  const text = stripAnsi(output);
  const timeouts = text.match(TIMEOUT)?.length ?? 0;
  if (timeouts === 0) return false;
  if (/does not meet .*threshold|ERROR: Coverage/.test(text)) return false;
  if (/^\s*FAIL\s/m.test(text)) return false;
  const files = text.match(/Test Files\s+(.*)$/m)?.[1] ?? '';
  const tests = text.match(/Tests\s+(.*)$/m)?.[1] ?? '';
  if (!/^\d+ passed \(\d+\)$/.test(files.trim())) return false;
  if (/failed/.test(tests)) return false;
  const errors = text.match(/Errors\s+(\d+) errors?\b/);
  return errors !== null && Number(errors[1]) === timeouts;
}

// Runs once; retries only when the first attempt failed with the worker RPC timeout alone.
export async function runWithRetry(run, log = () => {}) {
  const first = await run();
  if (first.code === 0) return 0;
  if (!onlyWorkerRpcTimeout(first.output)) return first.code;
  log('The only failure was the vitest worker RPC timeout, and every test file passed. Retrying once.');
  const second = await run();
  if (second.code === 0) return 0;
  if (!onlyWorkerRpcTimeout(second.output)) return second.code;
  // Until the vitest 4 upgrade (which fixes this timeout upstream) lands, a second run that again fails
  // only on the worker RPC timeout, with every test file passing and no threshold failure, passes with a
  // warning instead of failing the PR.
  log('::warning title=vitest worker RPC timeout::Both runs failed only on the vitest 3.2.7 worker RPC timeout, with every test file passing and no coverage threshold failure. Passing until the vitest 4 upgrade lands.');
  return 0;
}

export function runFrontendCoverage() {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['--dir', 'frontend', 'run', 'test:coverage'], { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWithRetry(runFrontendCoverage, (message) => console.log(message));
}
