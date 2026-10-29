import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const fixture = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'test',
    'fixtures',
    'production-runtime-secret.json',
  ),
  'utf8',
);

function replaceStdin(chunks: Array<string | Buffer>): void {
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
  });
}

describe('runtime secret contract command', () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalExitCode = process.exitCode;

  afterEach(() => {
    if (stdin) Object.defineProperty(process, 'stdin', stdin);
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('passes a valid payload without printing configuration values', async () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    replaceStdin([fixture]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { main } = require('./runtime-secret-contract') as {
      main: () => Promise<void>;
    };

    await main();

    expect(stdout).toHaveBeenCalledWith(
      'Alcantara production secret contract passed\n',
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('fails with a redacted message for an invalid payload', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    replaceStdin(['{"alanaControlToken":"DO_NOT_PRINT"}']);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { main } = require('./runtime-secret-contract') as {
      main: () => Promise<void>;
    };

    await main();

    const message = String(stderr.mock.calls[0][0]);
    expect(message).toMatch(/^Alcantara production secret contract failed: /);
    expect(message).not.toContain('DO_NOT_PRINT');
    expect(process.exitCode).toBe(1);
  });

  it('rejects oversized input', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    replaceStdin([Buffer.alloc(70_000, 'a')]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { main } = require('./runtime-secret-contract') as {
      main: () => Promise<void>;
    };

    await main();

    expect(String(stderr.mock.calls[0][0])).toContain(
      'Alcantara runtime configuration is malformed',
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports an unknown failure when a non-Error is thrown', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      get() {
        throw 'not an error';
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { main } = require('./runtime-secret-contract') as {
      main: () => Promise<void>;
    };

    await main();

    expect(stderr).toHaveBeenCalledWith(
      'Alcantara production secret contract failed: unknown failure\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it('runs the contract check as soon as the command file is loaded', async () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    replaceStdin([fixture]);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./runtime-secret-contract-cli');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdout).toHaveBeenCalledWith(
      'Alcantara production secret contract passed\n',
    );
  });
});
