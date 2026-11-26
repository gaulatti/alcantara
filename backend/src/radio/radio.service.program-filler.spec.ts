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

  it('starts with the legacy prepared version exactly as before when no program filler exists', async () => {
    const h = build(null);
    await h.service.setRecoveryAutomation('radio-1', 'start');
    expect(h.palazzo.commandAutomation.mock.calls[0][5]).toBe('filler-legacy');
    expect(h.prisma.fillerLeg.updateMany).not.toHaveBeenCalled();
  });
});
