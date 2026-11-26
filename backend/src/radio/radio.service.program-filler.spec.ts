/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Prisma and Palazzo doubles are untyped */
import { ConflictException } from '@nestjs/common';
import { RadioService } from './radio.service';

// gaulatti/alcantara#126: once a program radio filler is configured, the
// legacy recovery writer stops writing the radio filler and recovery Start
// binds to the configured version. Without one, both behave as before.

function build(
  leg: {
    pendingVersionId?: string | null;
    activeVersionId?: string | null;
  } | null,
) {
  let radioLeg = leg
    ? { pendingVersionId: null, activeVersionId: null, ...leg }
    : null;
  const settings = {
    id: 3,
    palazzoUrl: 'http://palazzo:3100',
    fillerSongIds: [5],
    fillerVersion: 'filler-legacy',
  };
  const prisma: any = {
    programState: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, radioSettings: settings }),
    },
    radioSettings: { update: jest.fn() },
    song: { findMany: jest.fn() },
    fillerLeg: {
      findUnique: jest.fn(() => Promise.resolve(radioLeg)),
      updateMany: jest.fn(({ where, data }: any) => {
        const matches =
          radioLeg !== null &&
          (where.pendingVersionId === undefined ||
            radioLeg.pendingVersionId === where.pendingVersionId);
        if (matches) radioLeg = { ...radioLeg!, ...data };
        return Promise.resolve({ count: matches ? 1 : 0 });
      }),
    },
  };
  const palazzo: any = {
    getAutomation: jest.fn().mockResolvedValue({
      lastSequence: 4,
      requestedState: 'stopped',
      actualState: 'stopped',
      filler: { activeVersion: null, ready: true },
    }),
    commandAutomation: jest.fn().mockResolvedValue(undefined),
    prepareFiller: jest.fn(),
    validateBaseUrl: jest.fn((value: string) => value),
  };
  const metrics: any = { recordRecoveryPreparation: jest.fn() };
  const service = new RadioService(
    prisma,
    palazzo,
    { get: jest.fn() } as any,
    metrics,
    { teamId: 0 } as never,
  );
  return { service, prisma, palazzo, metrics, leg: () => radioLeg };
}

describe('recovery playlist with a program radio filler', () => {
  it('refuses the legacy writer once the program filler is configured', async () => {
    const h = build({ pendingVersionId: 'filler-radio-1' });
    await expect(
      h.service.prepareRecoveryPlaylist('radio-1', [5]),
    ).rejects.toThrow(
      new ConflictException(
        'the radio filler is managed by the program filler configuration',
      ),
    );
    expect(h.prisma.song.findMany).not.toHaveBeenCalled();
    expect(h.palazzo.prepareFiller).not.toHaveBeenCalled();
    expect(h.prisma.radioSettings.update).not.toHaveBeenCalled();
    expect(h.metrics.recordRecoveryPreparation).toHaveBeenCalledWith('failed');
  });

  it('binds recovery Start to the pending program version and makes it active', async () => {
    const h = build({
      pendingVersionId: 'filler-radio-1',
      activeVersionId: 'filler-radio-0',
    });
    await h.service.setRecoveryAutomation('radio-1', 'start');
    expect(h.palazzo.commandAutomation).toHaveBeenCalledWith(
      'http://palazzo:3100',
      'radio-1',
      'start',
      5,
      expect.any(String),
      'filler-radio-1',
    );
    expect(h.leg()).toEqual({
      pendingVersionId: null,
      activeVersionId: 'filler-radio-1',
    });
  });

  it('starts again with the active program version when nothing is pending', async () => {
    const h = build({ activeVersionId: 'filler-radio-0' });
    await h.service.setRecoveryAutomation('radio-1', 'start');
    expect(h.palazzo.commandAutomation.mock.calls[0][5]).toBe('filler-radio-0');
    expect(h.leg()).toEqual({
      pendingVersionId: null,
      activeVersionId: 'filler-radio-0',
    });
  });

  it('stops without touching the program filler', async () => {
    const h = build({ pendingVersionId: 'filler-radio-1' });
    await h.service.setRecoveryAutomation('radio-1', 'stop');
    expect(h.palazzo.commandAutomation.mock.calls[0][5]).toBeUndefined();
    expect(h.prisma.fillerLeg.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'filler-radio-1'],
    ['filler-radio-2', 'filler-radio-2'],
  ])(
    'releases the active program filler on Stop (pending %s)',
    async (pending, next) => {
      const h = build({
        pendingVersionId: pending,
        activeVersionId: 'filler-radio-1',
      });
      await h.service.setRecoveryAutomation('radio-1', 'stop');
      expect(h.leg()).toEqual({
        pendingVersionId: next,
        activeVersionId: null,
      });
    },
  );

  it('stops even when the release write fails, and counts it', async () => {
    const managed = { recordFillerRelease: jest.fn() };
    const h = build({ activeVersionId: 'filler-radio-1' });
    (h.service as unknown as { managedMetrics: unknown }).managedMetrics =
      managed;
    h.prisma.fillerLeg.updateMany.mockRejectedValueOnce(new Error('down'));
    await expect(
      h.service.setRecoveryAutomation('radio-1', 'stop'),
    ).resolves.toMatchObject({ connection: 'connected' });
    expect(h.palazzo.commandAutomation.mock.calls[0][2]).toBe('stop');
    expect(managed.recordFillerRelease).toHaveBeenCalledWith('radio', 'failed');
    // The Stop reads the leg once for its version, then once to release it.
    h.prisma.fillerLeg.findUnique
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce('not an error');
    await h.service.setRecoveryAutomation('radio-1', 'stop');
    await h.service.setRecoveryAutomation('radio-1', 'stop');
    expect(managed.recordFillerRelease).toHaveBeenLastCalledWith(
      'radio',
      'released',
    );
  });

  it.each([
    [null, 'filler-radio-1'],
    ['filler-radio-2', 'filler-radio-2'],
  ])(
    'airs after Stop the filler a Start would air without it (pending %s)',
    async (pending, aired) => {
      const leg = {
        pendingVersionId: pending,
        activeVersionId: 'filler-radio-1',
      };
      const without = build({ ...leg });
      await without.service.setRecoveryAutomation('radio-1', 'start');
      const h = build({ ...leg });
      await h.service.setRecoveryAutomation('radio-1', 'stop');
      await h.service.setRecoveryAutomation('radio-1', 'start');
      expect(without.palazzo.commandAutomation.mock.calls[0][5]).toBe(aired);
      expect(h.palazzo.commandAutomation.mock.calls[1][5]).toBe(aired);
    },
  );

  it('reports recovery running only when Palazzo says so', async () => {
    const h = build(null);
    await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(false);
    // Palazzo's own words for a running session: requested running, actually ready or degraded, a filler bound.
    const answers = (requestedState: string, ready: boolean) =>
      h.palazzo.getAutomation.mockResolvedValueOnce({
        requestedState,
        actualState: 'degraded',
        filler: { ready },
      });
    answers('running', true);
    await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(true);
    answers('running', false);
    await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(false);
    answers('stopped', true);
    await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(false);
    h.palazzo.getAutomation.mockRejectedValueOnce(new Error('down'));
    await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(false);
    for (const state of [null, { radioSettings: null }]) {
      h.prisma.programState.findUnique.mockResolvedValueOnce(state);
      await expect(h.service.isRecoveryRunning('radio-1')).resolves.toBe(false);
    }
    expect(h.palazzo.getAutomation).toHaveBeenCalledTimes(5);
  });

  it('starts with the legacy prepared version exactly as before when no program filler exists', async () => {
    const h = build(null);
    await h.service.setRecoveryAutomation('radio-1', 'start');
    expect(h.palazzo.commandAutomation.mock.calls[0][5]).toBe('filler-legacy');
    expect(h.prisma.fillerLeg.updateMany).not.toHaveBeenCalled();
  });
});
