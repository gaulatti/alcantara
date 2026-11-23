import { spawn } from 'node:child_process';

export type ProcessFailure = 'spawn' | 'timeout' | 'exit' | 'output-limit';

export class ProcessRunError extends Error {
  constructor(readonly failure: ProcessFailure) {
    super(`Process failed: ${failure}`);
  }
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ProcessOutput>;

type SpawnProcess = typeof spawn;

/**
 * Runs one tool with no shell, no stdin, a hard deadline and a cap on the
 * output it keeps. A timeout or an oversized output kills the process.
 */
export function createProcessRunner(
  spawnProcess: SpawnProcess = spawn,
): ProcessRunner {
  return (command, args, options) =>
    new Promise<ProcessOutput>((resolve, reject) => {
      const child = spawnProcess(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;

      const finish = (failure: ProcessFailure | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure === null) {
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
          return;
        }
        if (failure !== 'spawn' && failure !== 'exit') child.kill('SIGKILL');
        reject(new ProcessRunError(failure));
      };

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > options.maxOutputBytes) {
          finish('output-limit');
          return;
        }
        target.push(chunk);
      };

      const timer = setTimeout(() => finish('timeout'), options.timeoutMs);
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => finish('spawn'));
      child.once('close', (code) => finish(code === 0 ? null : 'exit'));
    });
}
