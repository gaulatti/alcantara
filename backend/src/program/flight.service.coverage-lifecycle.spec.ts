/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FlightService } from './flight.service';
import { RadioMetricsService } from '../radio/radio-metrics.service';

function minuteAt(offsetMs: number): string {
  const date = new Date(Date.now() + offsetMs);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function harness(stateExtra: Record<string, unknown> = {}) {
  const prisma = {
    programState: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        programId: 'radio-1',
        type: 'radio',
        activeFlightSequenceId: null,
        ...stateExtra,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    flightSequence: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    song: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 1,
          enabled: true,
          audioUrl: 'https://media.test/1.mp3',
          durationMs: 1000,
        },
      ]),
    },
    instant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const program = {
    broadcastUpdate: jest.fn(),
    takeProgramSongOffAir: jest.fn().mockResolvedValue(undefined),
    stopProgramSongForTimedBlock: jest.fn().mockResolvedValue(undefined),
  };
  const metrics = new RadioMetricsService();
  const recorded = jest.spyOn(metrics, 'recordRadioLogResult');
  const service = new FlightService(prisma as any, program as any, metrics);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    prisma,
    program,
    recorded,
    service,
    internals: service as any,
  };
}

function runtimeState(extra: Record<string, unknown> = {}) {
  return {
    sequenceId: 7,
    programId: 'radio-1',
    items: [
      { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
      { id: 'b', kind: 'playSong', songId: 1 },
      { id: 'c', kind: 'playSong', songId: 1, clockOffsetSeconds: 1800 },
    ],
    loop: false,
    activeIndex: 0,
    isRunning: true,
    generation: 1,
    timer: null,
    waitingForSongEnd: false,
    startedAt: Date.now(),
    scheduledAtMs: Date.now(),
    ...extra,
  } as any;
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('FlightService updates of plain sequences', () => {
  const plain = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'Old',
    revision: 5,
    loop: false,
    scheduledAt: null,
    publishedAt: null,
    lastStartedAt: null,
    items: [{ id: 'w', kind: 'wait', durationMs: 10 }],
    ...extra,
  });

  function setup(existing = plain()) {
    const h = harness();
    h.prisma.flightSequence.findFirst.mockResolvedValue(existing);
    h.prisma.flightSequence.findUniqueOrThrow.mockResolvedValue(existing);
    return h;
  }

  it('reports a missing sequence without counting a clocked failure', async () => {
    const { service, prisma, recorded } = setup();
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(
      service.updateFlightSequence('radio-1', 7, {}),
    ).rejects.toThrow(new NotFoundException('flight sequence not found'));
    expect(recorded).not.toHaveBeenCalled();
  });

  it('applies only meaningful fields and bumps the revision', async () => {
    const { service, prisma, recorded } = setup();
    const result = await service.updateFlightSequence('radio-1', 7, {
      name: '  New  ',
      loop: true,
      items: [{ id: 'x', kind: 'wait', durationMs: 5 }, { kind: 'bogus' }],
    });
    expect(prisma.flightSequence.updateMany).toHaveBeenCalledWith({
      where: { id: 7, revision: 5 },
      data: {
        name: 'New',
        loop: true,
        items: [{ id: 'x', kind: 'wait', label: undefined, durationMs: 5 }],
        revision: { increment: 1 },
      },
    });
    expect(result.id).toBe(7);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('ignores blank and non-string names and non-boolean loops', async () => {
    const { service, prisma } = setup();
    await service.updateFlightSequence('radio-1', 7, {
      name: '   ',
      loop: 'yes' as any,
    });
    await service.updateFlightSequence('radio-1', 7, { name: 5 as any });
    expect(prisma.flightSequence.updateMany.mock.calls[0][0].data).toEqual({
      revision: { increment: 1 },
    });
    expect(prisma.flightSequence.updateMany.mock.calls[1][0].data).toEqual({
      revision: { increment: 1 },
    });
  });

  it('rejects non-array items', async () => {
    const { service, prisma } = setup();
    await expect(
      service.updateFlightSequence('radio-1', 7, { items: 'nope' }),
    ).rejects.toThrow(new BadRequestException('items must be an array'));
    expect(prisma.flightSequence.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a schedule on a program without a radio leg', async () => {
    const { service, prisma } = setup();
    prisma.programState.findUnique.mockResolvedValue({ id: 1, type: 'tv' });
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        scheduledAt: minuteAt(3_600_000),
      }),
    ).rejects.toThrow(new BadRequestException('program has no radio leg'));
  });

  it('rejects scheduling a looping sequence, from either the patch or the record', async () => {
    const { service, prisma } = setup();
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        scheduledAt: minuteAt(3_600_000),
        loop: true,
      }),
    ).rejects.toThrow(new BadRequestException('a clocked log cannot loop'));
    prisma.flightSequence.findFirst.mockResolvedValue(plain({ loop: true }));
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        scheduledAt: minuteAt(3_600_000),
      }),
    ).rejects.toThrow('a clocked log cannot loop');
  });

  it('turns a plain sequence into a validated clocked draft', async () => {
    const { service, prisma } = setup();
    const scheduledAt = minuteAt(3_600_000);
    await service.updateFlightSequence('radio-1', 7, {
      scheduledAt,
      items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
    });
    expect(
      prisma.flightSequence.updateMany.mock.calls[0][0].data,
    ).toMatchObject({ scheduledAt: new Date(scheduledAt) });
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        scheduledAt,
        items: [{ id: 'a', kind: 'wait' }],
      }),
    ).rejects.toThrow('each log item needs an ID and supported cue kind');
  });

  it('validates existing items when only the schedule is added', async () => {
    const { service } = setup();
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        scheduledAt: minuteAt(3_600_000),
      }),
    ).rejects.toThrow('clocked logs support songs, clips, and stop cues');
  });

  it('schedules an emptied sequence without clock validation', async () => {
    const { service, prisma } = setup();
    await service.updateFlightSequence('radio-1', 7, {
      scheduledAt: minuteAt(3_600_000),
      items: [],
    });
    expect(
      prisma.flightSequence.updateMany.mock.calls[0][0].data.items,
    ).toEqual([]);
  });

  it('allows clearing the schedule', async () => {
    const { service, prisma } = setup(
      plain({ scheduledAt: new Date(), revision: 5 }) as any,
    );
    await service.updateFlightSequence('radio-1', 7, {
      revision: 5,
      scheduledAt: null,
    });
    expect(
      prisma.flightSequence.updateMany.mock.calls[0][0].data,
    ).toMatchObject({ scheduledAt: null });
  });

  it('reports a concurrent revision change at write time', async () => {
    const { service, prisma } = setup();
    prisma.flightSequence.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.updateFlightSequence('radio-1', 7, { name: 'N' }),
    ).rejects.toThrow(
      new ConflictException('log revision changed; reload before editing'),
    );
    expect(prisma.flightSequence.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('maps duplicate names, naming the new or the existing one', async () => {
    const { service, prisma } = setup();
    prisma.flightSequence.updateMany.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.updateFlightSequence('radio-1', 7, { name: 'Taken' }),
    ).rejects.toThrow(
      new BadRequestException('flight sequence "Taken" already exists'),
    );
    await expect(
      service.updateFlightSequence('radio-1', 7, { loop: true }),
    ).rejects.toThrow(
      new BadRequestException('flight sequence "Old" already exists'),
    );
  });

  it('rethrows other write errors untouched', async () => {
    const { service, prisma } = setup();
    const boom = new Error('boom');
    prisma.flightSequence.updateMany.mockRejectedValue(boom);
    await expect(
      service.updateFlightSequence('radio-1', 7, { name: 'N' }),
    ).rejects.toBe(boom);
    prisma.flightSequence.updateMany.mockRejectedValue('text failure');
    await expect(
      service.updateFlightSequence('radio-1', 7, { name: 'N' }),
    ).rejects.toBe('text failure');
  });

  it('serializes concurrent edits of the same program', async () => {
    const { service, prisma } = setup();
    const order: string[] = [];
    let releaseFirst!: () => void;
    prisma.flightSequence.updateMany.mockImplementationOnce(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
      return { count: 1 };
    });
    prisma.flightSequence.updateMany.mockImplementationOnce(async () => {
      order.push('second');
      return { count: 1 };
    });
    const first = service.updateFlightSequence('radio-1', 7, { name: 'A' });
    const second = service.updateFlightSequence('radio-1', 7, { name: 'B' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect((service as any).cueOperations.size).toBe(0);
  });

  it('keeps serving the queue after an earlier operation fails', async () => {
    const { internals } = setup();
    const failed = internals.serializeCueOperation('p', async () => {
      throw new Error('first failed');
    });
    const next = internals.serializeCueOperation('p', async () => 'ok');
    await expect(failed).rejects.toThrow('first failed');
    await expect(next).resolves.toBe('ok');
    expect(internals.cueOperations.size).toBe(0);
  });
});

describe('FlightService updates of clocked logs', () => {
  const items = [
    { id: 'now', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
    { id: 'later', kind: 'playSong', songId: 1 },
    { id: 'hard', kind: 'playSong', songId: 1, clockOffsetSeconds: 1800 },
  ];
  const clocked = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'Hour',
    revision: 5,
    loop: false,
    scheduledAt: new Date(Date.now() + 3_600_000),
    publishedAt: null,
    lastStartedAt: null,
    items,
    ...extra,
  });

  function setup(existing: any = clocked()) {
    const h = harness();
    h.prisma.flightSequence.findFirst.mockResolvedValue(existing);
    h.prisma.flightSequence.findUniqueOrThrow.mockResolvedValue(existing);
    return h;
  }

  it('requires the current revision and counts the failure', async () => {
    const { service, recorded } = setup();
    await expect(
      service.updateFlightSequence('radio-1', 7, { revision: 4 }),
    ).rejects.toThrow(
      new ConflictException('log revision changed; reload before editing'),
    );
    await expect(
      service.updateFlightSequence('radio-1', 7, {}),
    ).rejects.toThrow(ConflictException);
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveBeenCalledWith('edit-failed');
  });

  it('counts a successful edit', async () => {
    const { service, recorded } = setup();
    await service.updateFlightSequence('radio-1', 7, {
      revision: 5,
      name: 'Renamed',
    });
    expect(recorded).toHaveBeenCalledWith('edited');
  });

  it.each([
    ['items', { items: [] }],
    ['scheduledAt', { scheduledAt: null }],
    ['loop', { loop: false }],
  ])('refuses rewriting an aired log via %s', async (_name, patch) => {
    const { service } = setup(clocked({ lastStartedAt: new Date() }));
    await expect(
      service.updateFlightSequence('radio-1', 7, { revision: 5, ...patch }),
    ).rejects.toThrow(
      new ConflictException('an aired or stopped log cannot be rewritten'),
    );
  });

  it('still allows renaming an aired log', async () => {
    const { service, prisma } = setup(clocked({ lastStartedAt: new Date() }));
    await service.updateFlightSequence('radio-1', 7, {
      revision: 5,
      name: 'Aired',
    });
    expect(prisma.flightSequence.updateMany.mock.calls[0][0].data.name).toBe(
      'Aired',
    );
  });

  it('refuses rescheduling a published log', async () => {
    const { service } = setup(clocked({ publishedAt: new Date() }));
    await expect(
      service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        scheduledAt: minuteAt(7_200_000),
      }),
    ).rejects.toThrow(
      new ConflictException(
        'a published log cannot change its scheduled start',
      ),
    );
  });

  it('re-runs preflight for published logs', async () => {
    const { service, prisma } = setup(clocked({ publishedAt: new Date() }));
    await service.updateFlightSequence('radio-1', 7, {
      revision: 5,
      items: items.slice(0, 2),
    });
    expect(prisma.song.findMany).toHaveBeenCalled();
    prisma.song.findMany.mockResolvedValue([]);
    await expect(
      service.updateFlightSequence('radio-1', 7, { revision: 5 }),
    ).rejects.toThrow(
      new BadRequestException(
        'Item 1: song unavailable; Item 2: song unavailable; Item 3: song unavailable',
      ),
    );
  });

  describe('while on air', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    function onAir(runtimeExtra: Record<string, unknown> = {}) {
      jest.useFakeTimers();
      const h = setup(
        clocked({
          publishedAt: new Date(),
          lastStartedAt: new Date(),
          isRunning: true,
        }),
      );
      const runtime = runtimeState({
        items: items as any,
        ...runtimeExtra,
      });
      h.internals.runtimes.set('radio-1', runtime);
      return { ...h, runtime };
    }

    it('refuses schedule or loop changes', async () => {
      const { service } = onAir();
      await expect(
        service.updateFlightSequence('radio-1', 7, {
          revision: 5,
          loop: false,
        }),
      ).rejects.toThrow(
        new ConflictException(
          'an on-air log cannot change its schedule or loop',
        ),
      );
      await expect(
        service.updateFlightSequence('radio-1', 7, {
          revision: 5,
          scheduledAt: undefined,
          loop: undefined,
          items: [],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses editing the played prefix and truncating below it', async () => {
      const { service } = onAir({ activeIndex: 1 });
      await expect(
        service.updateFlightSequence('radio-1', 7, {
          revision: 5,
          items: [items[0]],
        }),
      ).rejects.toThrow(
        new ConflictException('on-air and played log items cannot be edited'),
      );
    });

    it('re-arms the next hard cue while waiting for a song end', async () => {
      const { service, runtime, internals } = onAir({
        waitingForSongEnd: true,
      });
      const arm = jest.spyOn(internals, 'armNextHardCue');
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [items[0], items[2]],
      });
      expect(arm).toHaveBeenCalledWith(runtime);
      expect(runtime.items.map((i: any) => i.id)).toEqual(['now', 'hard']);
      expect(runtime.timer).not.toBeNull();
    });

    it('re-arms a declared clip timer', async () => {
      const clip = {
        id: 'clip',
        kind: 'instant',
        instantId: 3,
        durationMs: 5000,
        clockOffsetSeconds: 0,
      };
      const { service, runtime, internals, prisma } = onAir({
        items: [clip, items[1]],
        cueStartedAt: Date.now(),
      });
      prisma.flightSequence.findFirst.mockResolvedValue(
        clocked({
          publishedAt: new Date(),
          lastStartedAt: new Date(),
          items: [clip, items[1]],
        }),
      );
      prisma.instant.findMany.mockResolvedValue([
        { id: 3, enabled: true, audioUrl: 'x' },
      ]);
      const arm = jest.spyOn(internals, 'armTimedClip');
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [clip, items[1], { id: 'new', kind: 'stopSong' }],
      });
      expect(arm).toHaveBeenCalledWith(runtime);
    });

    it('leaves timers alone for other active cues', async () => {
      const { service, runtime, internals } = onAir();
      const armHard = jest.spyOn(internals, 'armNextHardCue');
      const armClip = jest.spyOn(internals, 'armTimedClip');
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [...items, { id: 'tail', kind: 'stopSong' }],
      });
      expect(runtime.items).toHaveLength(4);
      expect(armHard).not.toHaveBeenCalled();
      expect(armClip).not.toHaveBeenCalled();
    });

    it('leaves timers alone for a clip without a declared duration', async () => {
      const clip = {
        id: 'clip',
        kind: 'instant',
        instantId: 3,
        clockOffsetSeconds: 0,
      };
      const { service, internals, prisma } = onAir({ items: [clip] });
      prisma.flightSequence.findFirst.mockResolvedValue(
        clocked({
          publishedAt: new Date(),
          lastStartedAt: new Date(),
          items: [clip],
        }),
      );
      prisma.instant.findMany.mockResolvedValue([
        { id: 3, enabled: true, audioUrl: 'x' },
      ]);
      const armClip = jest.spyOn(internals, 'armTimedClip');
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [clip, { id: 'tail', kind: 'stopSong' }],
      });
      expect(armClip).not.toHaveBeenCalled();
    });

    it('ignores another sequence running on the program', async () => {
      const { service, runtime } = onAir({ sequenceId: 99 });
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [items[0]],
      });
      expect(runtime.items).toHaveLength(3);
    });

    it('ignores a stopped runtime', async () => {
      const { service, runtime, prisma } = onAir({ isRunning: false });
      prisma.flightSequence.findFirst.mockResolvedValue(
        clocked({ publishedAt: new Date() }),
      );
      await service.updateFlightSequence('radio-1', 7, {
        revision: 5,
        items: [items[0]],
      });
      expect(runtime.items).toHaveLength(3);
    });
  });
});

describe('FlightService deletion', () => {
  const existing = { id: 7, programStateId: 1 };

  it('reports a missing sequence', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(service.deleteFlightSequence('radio-1', 7)).rejects.toThrow(
      new NotFoundException('flight sequence not found'),
    );
    expect(prisma.flightSequence.delete).not.toHaveBeenCalled();
  });

  it('deletes an idle sequence without touching the active pointer', async () => {
    const { service, prisma, internals } = harness({
      activeFlightSequenceId: 3,
    });
    prisma.flightSequence.findFirst.mockResolvedValue(existing);
    internals.runtimes.set('radio-1', runtimeState({ sequenceId: 99 }));
    const stop = jest.spyOn(service, 'stop');
    await expect(service.deleteFlightSequence('radio-1', 7)).resolves.toEqual({
      deletedId: 7,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(internals.runtimes.has('radio-1')).toBe(true);
    expect(prisma.flightSequence.delete).toHaveBeenCalledWith({
      where: { id: 7 },
    });
    expect(prisma.programState.update).not.toHaveBeenCalled();
  });

  it('stops a running sequence and clears the active pointer', async () => {
    const { service, prisma, internals } = harness({
      activeFlightSequenceId: 7,
    });
    prisma.flightSequence.findFirst.mockResolvedValue(existing);
    internals.runtimes.set('radio-1', runtimeState());
    const stop = jest.spyOn(service, 'stop').mockResolvedValue({ ok: true });
    await service.deleteFlightSequence('radio-1', 7);
    expect(stop).toHaveBeenCalledWith('radio-1');
    expect(internals.runtimes.has('radio-1')).toBe(false);
    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeFlightSequenceId: null },
    });
  });

  it('handles a program with no runtime at all', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(existing);
    await expect(service.deleteFlightSequence('radio-1', 7)).resolves.toEqual({
      deletedId: 7,
    });
  });
});

describe('FlightService activation', () => {
  const sequence = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    scheduledAt: null,
    publishedAt: null,
    items: [{ id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 }],
    ...extra,
  });

  it('reports a missing sequence', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(null);
    await expect(service.activateFlightSequence('radio-1', 7)).rejects.toThrow(
      new NotFoundException('flight sequence not found'),
    );
  });

  it('requires an unpublished clocked log to be published first', async () => {
    const { service, prisma } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(
      sequence({ scheduledAt: new Date() }),
    );
    await expect(service.activateFlightSequence('radio-1', 7)).rejects.toThrow(
      new BadRequestException('publish the clocked log before activating'),
    );
  });

  it('refuses a published clocked log whose audio is unavailable', async () => {
    const { service, prisma } = harness();
    prisma.song.findMany.mockResolvedValue([]);
    prisma.flightSequence.findFirst.mockResolvedValue(
      sequence({ scheduledAt: new Date(), publishedAt: new Date() }),
    );
    await expect(service.activateFlightSequence('radio-1', 7)).rejects.toThrow(
      new BadRequestException('Item 1: song unavailable'),
    );
  });

  it('activates a plain sequence after a full stop', async () => {
    const { service, prisma, internals } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(sequence());
    const stop = jest
      .spyOn(internals, 'stopRuntime')
      .mockResolvedValue({ ok: true });
    const broadcast = jest
      .spyOn(internals, 'broadcastFlightUpdate')
      .mockResolvedValue(undefined);
    await expect(
      service.activateFlightSequence(' radio-1 ', 7),
    ).resolves.toEqual({ activeSequenceId: 7 });
    expect(stop).toHaveBeenCalledWith('radio-1', false);
    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeFlightSequenceId: 7 },
    });
    expect(prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isRunning: false, activeItemId: null },
    });
    expect(broadcast).toHaveBeenCalledWith('radio-1', 7);
  });

  it('activates a clocked log without stopping when nothing is running', async () => {
    const { service, prisma, internals } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(
      sequence({ scheduledAt: new Date(), publishedAt: new Date() }),
    );
    const stop = jest
      .spyOn(internals, 'stopRuntime')
      .mockResolvedValue({ ok: true });
    jest.spyOn(internals, 'broadcastFlightUpdate').mockResolvedValue(undefined);
    await service.activateFlightSequence('radio-1', 7);
    expect(stop).not.toHaveBeenCalled();
  });

  it('preserves the rotation when replacing a running runtime for a clocked log', async () => {
    const { service, prisma, internals } = harness();
    prisma.flightSequence.findFirst.mockResolvedValue(
      sequence({ scheduledAt: new Date(), publishedAt: new Date() }),
    );
    internals.runtimes.set('radio-1', runtimeState());
    const stop = jest
      .spyOn(internals, 'stopRuntime')
      .mockResolvedValue({ ok: true });
    jest.spyOn(internals, 'broadcastFlightUpdate').mockResolvedValue(undefined);
    await service.activateFlightSequence('radio-1', 7);
    expect(stop).toHaveBeenCalledWith('radio-1', true);
    expect(internals.runtimes.has('radio-1')).toBe(false);
  });

  it('deactivates by stopping and clearing the pointer', async () => {
    const { service, prisma, internals } = harness();
    internals.runtimes.set('radio-1', runtimeState());
    const stop = jest.spyOn(service, 'stop').mockResolvedValue({ ok: true });
    const broadcast = jest
      .spyOn(internals, 'broadcastFlightUpdate')
      .mockResolvedValue(undefined);
    await expect(service.deactivateFlightSequence('radio-1')).resolves.toEqual({
      activeSequenceId: null,
    });
    expect(stop).toHaveBeenCalledWith('radio-1');
    expect(internals.runtimes.has('radio-1')).toBe(false);
    expect(prisma.programState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeFlightSequenceId: null },
    });
    expect(broadcast).toHaveBeenCalledWith('radio-1', null);
  });
});

describe('FlightService start', () => {
  const sequence = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    loop: true,
    scheduledAt: null,
    publishedAt: null,
    lastStartedAt: null,
    items: [{ id: 'w', kind: 'wait', durationMs: 10 }],
    ...extra,
  });

  function setup(seq: any = sequence(), state: Record<string, unknown> = {}) {
    const h = harness({ activeFlightSequenceId: 7, ...state });
    h.prisma.flightSequence.findUnique.mockResolvedValue(seq);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    const stopRuntime = jest
      .spyOn(h.internals, 'stopRuntime')
      .mockResolvedValue({ ok: true });
    jest
      .spyOn(h.internals, 'broadcastFlightUpdate')
      .mockResolvedValue(undefined);
    return { ...h, execute, stopRuntime };
  }

  it('requires an active sequence that still exists with cues', async () => {
    const { service, prisma } = setup(null, { activeFlightSequenceId: null });
    await expect(service.start('radio-1')).rejects.toThrow(
      new BadRequestException('no active flight sequence'),
    );
    prisma.programState.findUnique.mockResolvedValue({
      id: 1,
      activeFlightSequenceId: 7,
    });
    await expect(service.start('radio-1')).rejects.toThrow(
      new NotFoundException('active flight sequence not found'),
    );
    prisma.flightSequence.findUnique.mockResolvedValue(sequence({ items: [] }));
    await expect(service.start('radio-1')).rejects.toThrow(
      new BadRequestException('flight sequence has no cues'),
    );
  });

  it('requires a clocked log to be published and playable', async () => {
    const { service, prisma } = setup(sequence({ scheduledAt: new Date() }));
    await expect(service.start('radio-1')).rejects.toThrow(
      new BadRequestException('publish the clocked log before starting'),
    );
    prisma.flightSequence.findUnique.mockResolvedValue(
      sequence({
        scheduledAt: new Date(),
        publishedAt: new Date(),
        items: [
          { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
        ],
      }),
    );
    prisma.song.findMany.mockResolvedValue([]);
    await expect(service.start('radio-1')).rejects.toThrow(
      new BadRequestException('Item 1: song unavailable'),
    );
  });

  it('starts a plain sequence after stopping previous playout', async () => {
    const { service, prisma, internals, execute, stopRuntime, recorded } =
      setup();
    await expect(service.start(' radio-1 ')).resolves.toEqual({ ok: true });
    expect(stopRuntime).toHaveBeenCalledWith('radio-1', false);
    const runtime = internals.runtimes.get('radio-1');
    expect(runtime).toMatchObject({
      sequenceId: 7,
      programId: 'radio-1',
      loop: true,
      activeIndex: 0,
      isRunning: true,
      waitingForSongEnd: false,
      scheduledAtMs: null,
      timer: null,
    });
    expect(prisma.flightSequence.update).toHaveBeenCalledTimes(1);
    expect(prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isRunning: true, activeItemId: 'w' },
    });
    expect(recorded).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('radio-1', 0, runtime.generation);
  });

  it('claims and records the start of a never-started clocked log', async () => {
    const scheduledAt = new Date(Date.now() - 1000);
    const { service, prisma, internals, stopRuntime, recorded } = setup(
      sequence({
        loop: false,
        scheduledAt,
        publishedAt: new Date(),
        items: [
          { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
        ],
      }),
    );
    prisma.song.findMany.mockResolvedValue([
      { id: 1, enabled: true, audioUrl: 'x' },
    ]);
    await service.start('radio-1');
    expect(stopRuntime).not.toHaveBeenCalled();
    expect(prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { lastStartedAt: expect.any(Date) },
    });
    expect(internals.runtimes.get('radio-1').scheduledAtMs).toBe(
      scheduledAt.getTime(),
    );
    expect(recorded).toHaveBeenCalledWith('started');
  });

  it('does not re-claim a restarted clocked log and stops a prior runtime first', async () => {
    const { service, prisma, internals, stopRuntime } = setup(
      sequence({
        loop: false,
        scheduledAt: new Date(),
        publishedAt: new Date(),
        lastStartedAt: new Date(),
        items: [
          { id: 'a', kind: 'playSong', songId: 1, clockOffsetSeconds: 0 },
        ],
      }),
    );
    prisma.song.findMany.mockResolvedValue([
      { id: 1, enabled: true, audioUrl: 'x' },
    ]);
    internals.runtimes.set('radio-1', runtimeState());
    await service.start('radio-1');
    expect(stopRuntime).toHaveBeenCalledWith('radio-1', true);
    expect(prisma.flightSequence.update).not.toHaveBeenCalledWith({
      where: { id: 7 },
      data: { lastStartedAt: expect.any(Date) },
    });
  });
});

describe('FlightService stop', () => {
  function setup(stateExtra: Record<string, unknown> = {}) {
    const h = harness({ activeFlightSequenceId: 7, ...stateExtra });
    jest
      .spyOn(h.internals, 'broadcastFlightUpdate')
      .mockResolvedValue(undefined);
    return h;
  }

  it('stops playout without a runtime or active sequence', async () => {
    const { service, prisma, program } = setup({
      activeFlightSequenceId: null,
    });
    await expect(service.stop(' radio-1 ')).resolves.toEqual({ ok: true });
    expect(prisma.flightSequence.update).not.toHaveBeenCalled();
    expect(program.takeProgramSongOffAir).toHaveBeenCalledWith('radio-1');
    expect(program.stopProgramSongForTimedBlock).not.toHaveBeenCalled();
  });

  it('marks the active sequence stopped, clears timers and the runtime', async () => {
    jest.useFakeTimers();
    const { service, prisma, internals } = setup();
    const timer = setTimeout(() => undefined, 1000);
    const runtime = runtimeState({ timer, waitingForSongEnd: true });
    internals.runtimes.set('radio-1', runtime);
    await service.stop('radio-1');
    expect(prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isRunning: false },
    });
    expect(runtime.isRunning).toBe(false);
    expect(runtime.waitingForSongEnd).toBe(false);
    expect(runtime.timer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(internals.runtimes.has('radio-1')).toBe(false);
  });

  it('uses the timed-block stop and surfaces its failure while cleaning up', async () => {
    const { prisma, program, internals } = setup();
    const runtime = runtimeState();
    internals.runtimes.set('radio-1', runtime);
    program.stopProgramSongForTimedBlock.mockRejectedValue(new Error('cut'));
    await expect(internals.stopRuntime('radio-1', true)).rejects.toThrow('cut');
    expect(program.takeProgramSongOffAir).not.toHaveBeenCalled();
    expect(prisma.flightSequence.update).toHaveBeenCalled();
    expect(runtime.isRunning).toBe(false);
    expect(internals.runtimes.has('radio-1')).toBe(false);
  });

  it('swallows an off-air failure on a regular stop', async () => {
    const { service, program } = setup();
    program.takeProgramSongOffAir.mockRejectedValue(new Error('cut'));
    await expect(service.stop('radio-1')).resolves.toEqual({ ok: true });
  });

  it('does not remove a runtime that replaced the stopped one meanwhile', async () => {
    const { service, program, internals } = setup();
    const replacement = runtimeState({ generation: 2 });
    internals.runtimes.set('radio-1', runtimeState());
    program.takeProgramSongOffAir.mockImplementation(async () => {
      internals.runtimes.set('radio-1', replacement);
    });
    await service.stop('radio-1');
    expect(internals.runtimes.get('radio-1')).toBe(replacement);
  });
});

describe('FlightService manual advance', () => {
  function setup(runtime?: any) {
    const h = harness();
    if (runtime) h.internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    const finish = jest
      .spyOn(h.internals, 'finishBlock')
      .mockResolvedValue(undefined);
    const start = jest
      .spyOn(h.service, 'start')
      .mockResolvedValue({ ok: true });
    return { ...h, execute, finish, start };
  }

  it('starts the sequence when nothing is running', async () => {
    const { service, start } = setup();
    await expect(service.go('radio-1')).resolves.toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith('radio-1');
  });

  it('starts the sequence when the runtime is stopped', async () => {
    const { service, start } = setup(runtimeState({ isRunning: false }));
    await service.go('radio-1');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('refuses to advance a log before its scheduled start', async () => {
    const { service, execute } = setup(
      runtimeState({ scheduledAtMs: Date.now() + 60_000 }),
    );
    await expect(service.go('radio-1')).rejects.toThrow(
      new BadRequestException(
        'the log cannot advance before its scheduled start',
      ),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('advances to the next cue under a new generation', async () => {
    jest.useFakeTimers();
    const timer = setTimeout(() => undefined, 5000);
    const runtime = runtimeState({
      scheduledAtMs: Date.now() - 10,
      waitingForSongEnd: true,
      timer,
    });
    const { service, execute } = setup(runtime);
    await expect(service.go('radio-1')).resolves.toEqual({ ok: true });
    expect(runtime.waitingForSongEnd).toBe(false);
    expect(runtime.timer).toBeNull();
    expect(runtime.generation).toBe(2);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 2);
  });

  it('advances an unscheduled runtime', async () => {
    const { service, execute } = setup(
      runtimeState({ scheduledAtMs: null, activeIndex: 1 }),
    );
    await service.go('radio-1');
    expect(execute).toHaveBeenCalledWith('radio-1', 2, 2);
  });

  it('wraps a looping sequence and finishes a non-looping one', async () => {
    const looping = runtimeState({
      activeIndex: 2,
      loop: true,
      scheduledAtMs: null,
    });
    const first = setup(looping);
    await first.service.go('radio-1');
    expect(first.execute).toHaveBeenCalledWith('radio-1', 0, 2);
    expect(first.finish).not.toHaveBeenCalled();

    const ending = runtimeState({ activeIndex: 2, scheduledAtMs: null });
    const second = setup(ending);
    await second.service.go('radio-1');
    expect(second.finish).toHaveBeenCalledWith(ending);
    expect(second.execute).not.toHaveBeenCalled();
  });
});

describe('FlightService reset', () => {
  function setup(running: boolean, activeFlightSequenceId: number | null) {
    const h = harness({ activeFlightSequenceId });
    if (running) h.internals.runtimes.set('radio-1', runtimeState());
    const stop = jest.spyOn(h.service, 'stop').mockResolvedValue({ ok: true });
    const start = jest
      .spyOn(h.service, 'start')
      .mockResolvedValue({ ok: true });
    jest
      .spyOn(h.internals, 'broadcastFlightUpdate')
      .mockResolvedValue(undefined);
    return { ...h, stop, start };
  }

  it('restarts a running sequence after clearing its cursor', async () => {
    const { service, prisma, stop, start } = setup(true, 7);
    await expect(service.reset('radio-1')).resolves.toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith('radio-1');
    expect(prisma.flightSequence.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { activeItemId: null, isRunning: false },
    });
    expect(start).toHaveBeenCalledWith('radio-1');
  });

  it('only clears an idle sequence', async () => {
    const { service, start, stop, prisma } = setup(false, 7);
    await expect(service.reset('radio-1')).resolves.toEqual({ ok: true });
    expect(stop).toHaveBeenCalled();
    expect(prisma.flightSequence.update).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('handles a program with no active sequence', async () => {
    const { service, prisma, start } = setup(false, null);
    await service.reset('radio-1');
    expect(prisma.flightSequence.update).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('FlightService clocked-log ownership and song end', () => {
  it('only reports a clocked log as running once its start has passed', () => {
    const { service, internals } = harness();
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
    internals.runtimes.set('radio-1', runtimeState({ isRunning: false }));
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
    internals.runtimes.set('radio-1', runtimeState({ scheduledAtMs: null }));
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
    internals.runtimes.set(
      'radio-1',
      runtimeState({ scheduledAtMs: Date.now() + 60_000 }),
    );
    expect(service.isClockedLogRunning('radio-1')).toBe(false);
    internals.runtimes.set('radio-1', runtimeState());
    expect(service.isClockedLogRunning('radio-1')).toBe(true);
  });

  function setup(runtime?: any) {
    const h = harness();
    if (runtime) h.internals.runtimes.set('radio-1', runtime);
    const execute = jest
      .spyOn(h.internals, 'executeCueAtIndex')
      .mockResolvedValue(undefined);
    const finish = jest
      .spyOn(h.internals, 'finishBlock')
      .mockResolvedValue(undefined);
    return { ...h, execute, finish };
  }

  it.each([
    ['no runtime', undefined],
    [
      'a stopped runtime',
      runtimeState({ isRunning: false, waitingForSongEnd: true }),
    ],
    ['a runtime not waiting', runtimeState({ waitingForSongEnd: false })],
  ])('ignores a song end with %s', async (_name, runtime) => {
    const { service, execute, finish } = setup(runtime);
    await expect(service.handleSongEnded('radio-1')).resolves.toEqual({
      ok: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('advances to the next cue on a song end', async () => {
    jest.useFakeTimers();
    const timer = setTimeout(() => undefined, 5000);
    const runtime = runtimeState({ waitingForSongEnd: true, timer });
    const { service, execute } = setup(runtime);
    await expect(service.handleSongEnded('radio-1')).resolves.toEqual({
      ok: true,
    });
    expect(runtime.timer).toBeNull();
    expect(runtime.waitingForSongEnd).toBe(false);
    expect(execute).toHaveBeenCalledWith('radio-1', 1, 2);
  });

  it('wraps a looping sequence and finishes a non-looping one on a song end', async () => {
    const looping = runtimeState({
      waitingForSongEnd: true,
      activeIndex: 2,
      loop: true,
    });
    const first = setup(looping);
    await first.service.handleSongEnded('radio-1');
    expect(first.execute).toHaveBeenCalledWith('radio-1', 0, 2);

    const ending = runtimeState({ waitingForSongEnd: true, activeIndex: 2 });
    const second = setup(ending);
    await second.service.handleSongEnded('radio-1');
    expect(second.finish).toHaveBeenCalledWith(ending);
  });
});
