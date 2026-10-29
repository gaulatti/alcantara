interface Run {
  stdout: jest.SpyInstance;
  stderr: jest.SpyInstance;
  assertTestAuthSafety: jest.Mock;
  loadRuntimeSecrets: jest.Mock;
  validateRuntimeConfiguration: jest.Mock;
}

async function runPreflight(failure?: unknown, fail = false): Promise<Run> {
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const assertTestAuthSafety = jest.fn();
  const loadRuntimeSecrets = jest.fn().mockResolvedValue(undefined);
  const validateRuntimeConfiguration = jest.fn(() => {
    if (fail) throw failure;
  });
  jest.isolateModules(() => {
    jest.doMock('dotenv/config', () => ({}));
    jest.doMock('../auth/test-auth.service', () => ({ assertTestAuthSafety }));
    jest.doMock('./runtime-secrets', () => ({
      loadRuntimeSecrets,
      validateRuntimeConfiguration,
    }));
    require('./runtime-preflight');
  });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return {
    stdout,
    stderr,
    assertTestAuthSafety,
    loadRuntimeSecrets,
    validateRuntimeConfiguration,
  };
}

describe('runtime preflight', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('dotenv/config');
    process.exitCode = originalExitCode;
  });

  it('checks safety, loads secrets, validates, and reports success', async () => {
    const run = await runPreflight();
    expect(run.assertTestAuthSafety).toHaveBeenCalledTimes(1);
    expect(run.loadRuntimeSecrets).toHaveBeenCalledTimes(1);
    expect(run.validateRuntimeConfiguration).toHaveBeenCalledTimes(1);
    expect(run.stdout).toHaveBeenCalledWith(
      'Alcantara runtime preflight passed\n',
    );
    expect(run.stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('reports an Error message on stderr and sets a failing exit code', async () => {
    const run = await runPreflight(new Error('bad config'), true);
    expect(run.stderr).toHaveBeenCalledWith(
      'Alcantara runtime preflight failed: bad config\n',
    );
    expect(run.stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports unknown failure for non-Error rejections', async () => {
    const run = await runPreflight('plain string', true);
    expect(run.stderr).toHaveBeenCalledWith(
      'Alcantara runtime preflight failed: unknown failure\n',
    );
    expect(process.exitCode).toBe(1);
  });
});
