describe('principals CLI entry point', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function runEntry(run: jest.Mock) {
    jest.doMock('./principals-cli', () => ({
      runPrincipalMigrationCli: run,
    }));
    process.argv = ['node', 'principals-cli.main.ts', 'report', '/tmp/in.json'];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./principals-cli.main');
    });
    // Let the promise chain started at import time settle.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('forwards the arguments and exposes the CLI exit code', async () => {
    const run = jest.fn().mockResolvedValue(2);

    await runEntry(run);

    expect(run).toHaveBeenCalledWith(['report', '/tmp/in.json']);
    expect(process.exitCode).toBe(2);
    jest.dontMock('./principals-cli');
  });

  it('reports an Error rejection and fails the process', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const run = jest.fn().mockRejectedValue(new Error('database unavailable'));

    await runEntry(run);

    expect(error).toHaveBeenCalledWith('database unavailable');
    expect(process.exitCode).toBe(1);
    jest.dontMock('./principals-cli');
  });

  it('reports a non-Error rejection and fails the process', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const run = jest.fn().mockRejectedValue('boom');

    await runEntry(run);

    expect(error).toHaveBeenCalledWith('boom');
    expect(process.exitCode).toBe(1);
    jest.dontMock('./principals-cli');
  });
});
