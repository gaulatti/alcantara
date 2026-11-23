import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProcessRunner, ProcessRunError } from './process-runner';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
};

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> =
    [];
  const children: FakeChild[] = [];
  const spawnProcess = ((command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    calls.push({ command, args, options });
    children.push(child);
    process.nextTick(() => script(child));
    return child;
  }) as never;
  return { spawnProcess, calls, children };
}

const options = { timeoutMs: 1_000, maxOutputBytes: 64 };

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessRunError);
    return (error as ProcessRunError).failure;
  }
  throw new Error('expected a failure');
}

describe('createProcessRunner', () => {
  it('returns both outputs of a clean exit, with no shell and no stdin', async () => {
    const { spawnProcess, calls } = fakeSpawn((child) => {
      child.stdout.write('out');
      child.stderr.write('err');
      setImmediate(() => child.emit('close', 0));
    });
    const run = createProcessRunner(spawnProcess);

    await expect(run('ffprobe', ['-v', 'error'], options)).resolves.toEqual({
      stdout: 'out',
      stderr: 'err',
    });
    expect(calls).toEqual([
      {
        command: 'ffprobe',
        args: ['-v', 'error'],
        options: { stdio: ['ignore', 'pipe', 'pipe'] },
      },
    ]);
  });

  it('reports a non-zero exit without killing the finished process', async () => {
    const { spawnProcess, children } = fakeSpawn((child) =>
      child.emit('close', 1),
    );
    await expect(
      failure(createProcessRunner(spawnProcess)('ffmpeg', [], options)),
    ).resolves.toBe('exit');
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it('reports a process that cannot start', async () => {
    const { spawnProcess } = fakeSpawn((child) => {
      child.emit('error', new Error('ENOENT'));
      child.emit('close', -2);
    });
    await expect(
      failure(createProcessRunner(spawnProcess)('ffmpeg', [], options)),
    ).resolves.toBe('spawn');
  });

  it('kills a process that passes its deadline', async () => {
    const { spawnProcess, children } = fakeSpawn(() => undefined);
    await expect(
      failure(
        createProcessRunner(spawnProcess)('ffmpeg', [], {
          ...options,
          timeoutMs: 5,
        }),
      ),
    ).resolves.toBe('timeout');
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills a process whose output passes the cap', async () => {
    const { spawnProcess, children } = fakeSpawn((child) => {
      child.stderr.write(Buffer.alloc(40));
      child.stdout.write(Buffer.alloc(40));
      child.stdout.write(Buffer.alloc(40));
    });
    await expect(
      failure(createProcessRunner(spawnProcess)('ffmpeg', [], options)),
    ).resolves.toBe('output-limit');
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it('runs a real process by default', async () => {
    await expect(
      createProcessRunner()(
        process.execPath,
        ['-e', 'process.stdout.write("ok")'],
        { timeoutMs: 10_000, maxOutputBytes: 1024 },
      ),
    ).resolves.toEqual({ stdout: 'ok', stderr: '' });
  });
});
