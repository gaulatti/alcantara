import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { FlightService } from '../program/flight.service';
import { ProgramTemplateService } from '../program/program-template.service';
import { ProgramController } from '../program/program.controller';
import { ProgramService, startsSongPlayback } from '../program/program.service';
import { RadioController } from './radio.controller';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioService } from './radio.service';
import type { ProgramSongSequence } from './song-sequence.utils';
import { RendererAuthService } from '../renderer-keys/renderer-auth.service';
import { PompeiiService } from '../auth/pompeii.service';

// gaulatti/alcantara#609: a take or start on a radio-only program whose playout engine is off is
// refused with 409 and reason "engine_unavailable". TV and simulcast programs are unaffected.

const radioServiceWith = (state: unknown) =>
  new RadioService(
    {
      programState: { findUnique: jest.fn().mockResolvedValue(state) },
    } as any,
    {} as any,
    {} as any,
    new RadioMetricsService(),
    { teamId: 0 } as never,
  );

const sequence = (
  patch: Partial<ProgramSongSequence> = {},
): ProgramSongSequence => ({
  mode: 'manual',
  items: [
    {
      id: 'a',
      kind: 'preset',
      artist: 'A',
      title: 'One',
      coverUrl: '',
      audioUrl: 'https://media.example/1.mp3',
    },
    {
      id: 'b',
      kind: 'preset',
      artist: 'B',
      title: 'Two',
      coverUrl: '',
      audioUrl: 'https://media.example/2.mp3',
    },
  ] as ProgramSongSequence['items'],
  activeItemId: 'a',
  intervalMs: 4000,
  loop: false,
  startedAt: 1,
  ...patch,
});

describe('RadioService.refuseStartWhileEngineUnavailable', () => {
  it.each([
    [
      'radio, engine disabled',
      { type: 'radio', radioSettings: { enabled: false } },
    ],
    ['radio, no radio settings', { type: 'radio', radioSettings: null }],
  ])('refuses %s with 409 and reason engine_unavailable', async (_, state) => {
    const refusal = radioServiceWith(state)
      .refuseStartWhileEngineUnavailable('station')
      .catch((error: unknown) => error);
    const error = (await refusal) as ConflictException;
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      reason: 'engine_unavailable',
      message:
        'The radio engine is off (disabled in settings), so nothing was taken.',
    });
  });

  it.each([
    [
      'radio, engine enabled',
      { type: 'radio', radioSettings: { enabled: true } },
    ],
    [
      'simulcast, engine disabled',
      { type: 'both', radioSettings: { enabled: false } },
    ],
    ['tv, no radio settings', { type: 'tv', radioSettings: null }],
    ['an unknown program', null],
  ])('lets %s through', async (_, state) => {
    await expect(
      radioServiceWith(state).refuseStartWhileEngineUnavailable('station'),
    ).resolves.toBeUndefined();
  });
});

describe('alcantara_radio_start_refused_total', () => {
  const count = (metrics: RadioMetricsService) => {
    const line = metrics
      .render()
      .split('\n')
      .find((row) =>
        row.startsWith(
          'alcantara_radio_start_refused_total{reason="engine_unavailable"} ',
        ),
      );
    return Number(line?.split(' ')[1]);
  };

  it('counts a refusal by its bounded reason, and nothing for an allowed start', async () => {
    const metrics = new RadioMetricsService();
    const refusing = new RadioService(
      {
        programState: {
          findUnique: jest.fn().mockResolvedValue({
            type: 'radio',
            radioSettings: { enabled: false },
          }),
        },
      } as any,
      {} as any,
      {} as any,
      metrics,
      { teamId: 0 } as never,
    );
    expect(count(metrics)).toBe(0);
    await refusing
      .refuseStartWhileEngineUnavailable('station')
      .catch(() => undefined);
    expect(count(metrics)).toBe(1);
    const allowing = new RadioService(
      {
        programState: {
          findUnique: jest.fn().mockResolvedValue({
            type: 'radio',
            radioSettings: { enabled: true },
          }),
        },
      } as any,
      {} as any,
      {} as any,
      metrics,
      { teamId: 0 } as never,
    );
    await allowing.refuseStartWhileEngineUnavailable('station');
    expect(count(metrics)).toBe(1);
    expect(metrics.render()).toContain(
      '# TYPE alcantara_radio_start_refused_total counter',
    );
  });

  it('ignores a reason outside the bounded set', () => {
    const metrics = new RadioMetricsService();
    metrics.recordStartRefused('anything' as never);
    expect(count(metrics)).toBe(0);
    expect(metrics.render()).not.toContain('reason="anything"');
  });
});

describe('startsSongPlayback', () => {
  it('is true when a different song becomes active, or an idle manual rotation turns automatic', () => {
    expect(
      startsSongPlayback(sequence(), sequence({ activeItemId: 'b' })),
    ).toBe(true);
    expect(
      startsSongPlayback(sequence({ activeItemId: null }), sequence()),
    ).toBe(true);
    expect(startsSongPlayback(null, sequence())).toBe(true);
    expect(
      startsSongPlayback(
        null,
        sequence({ activeItemId: null, mode: 'autoplay' }),
      ),
    ).toBe(true);
    expect(
      startsSongPlayback(
        sequence({ activeItemId: null }),
        sequence({ activeItemId: null, mode: 'shuffle' }),
      ),
    ).toBe(true);
  });

  it('is false for edits that keep the active song, for stopping, and for an already automatic rotation', () => {
    expect(startsSongPlayback(sequence(), sequence({ loop: true }))).toBe(
      false,
    );
    expect(
      startsSongPlayback(sequence(), sequence({ activeItemId: null })),
    ).toBe(false);
    expect(
      startsSongPlayback(
        sequence({ mode: 'autoplay' }),
        sequence({ mode: 'shuffle' }),
      ),
    ).toBe(false);
    expect(
      startsSongPlayback(
        sequence({ activeItemId: null }),
        sequence({ activeItemId: null, mode: 'autoplay', items: [] }),
      ),
    ).toBe(false);
    expect(startsSongPlayback(sequence(), null)).toBe(false);
  });
});

describe('ProgramService.refuseOperatorStartWhileEngineUnavailable', () => {
  const programServiceWith = (stored: unknown, refuse: jest.Mock) => {
    const service = Object.create(ProgramService.prototype) as ProgramService;
    Object.assign(service as any, {
      prisma: {
        programState: { findUnique: jest.fn().mockResolvedValue(stored) },
      },
      radioService: { refuseStartWhileEngineUnavailable: refuse },
    });
    return service;
  };

  it('asks the engine check only for a write that starts a song on a radio-only program', async () => {
    const refuse = jest
      .fn()
      .mockRejectedValue(
        new ConflictException({ reason: 'engine_unavailable' }),
      );
    const service = programServiceWith(
      { type: 'radio', songSequence: sequence() },
      refuse,
    );
    await expect(
      service.refuseOperatorStartWhileEngineUnavailable(
        { songSequence: sequence({ activeItemId: 'b' }) },
        'station',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(refuse).toHaveBeenCalledWith('station');
  });

  it('lets edits, mixer-only writes, and other program types through without asking', async () => {
    const refuse = jest.fn();
    const radio = programServiceWith(
      { type: 'radio', songSequence: sequence() },
      refuse,
    );
    await radio.refuseOperatorStartWhileEngineUnavailable(
      { songSequence: sequence({ loop: true }) },
      'station',
    );
    await radio.refuseOperatorStartWhileEngineUnavailable(
      { mixerSettings: {} },
      'station',
    );
    await radio.refuseOperatorStartWhileEngineUnavailable(null, 'station');
    const tv = programServiceWith(
      { type: 'tv', songSequence: sequence() },
      refuse,
    );
    await tv.refuseOperatorStartWhileEngineUnavailable(
      { songSequence: sequence({ activeItemId: 'b' }) },
      'station',
    );
    expect(refuse).not.toHaveBeenCalled();
  });
});

describe('operator routes', () => {
  it('POST /radio/:id/song never reaches the engine when refused, and does when allowed', async () => {
    const engine = { handleManualSong: jest.fn() };
    const radio = { refuseStartWhileEngineUnavailable: jest.fn() };
    const controller = new RadioController(
      radio as any,
      engine as any,
      {} as any,
      {} as any,
      {} as any,
      undefined as never,
    );
    radio.refuseStartWhileEngineUnavailable.mockRejectedValueOnce(
      new ConflictException({ reason: 'engine_unavailable' }),
    );
    await expect(
      controller.playSong('station', {
        audioUrl: 'https://media.example/1.mp3',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(engine.handleManualSong).not.toHaveBeenCalled();
    await expect(
      controller.playSong('station', {
        audioUrl: 'https://media.example/1.mp3',
      }),
    ).resolves.toEqual({ ok: true });
    expect(engine.handleManualSong).toHaveBeenCalledTimes(1);
  });

  it('PUT /program/:id/audio-bus answers 409 with reason engine_unavailable and writes nothing', async () => {
    const updateProgramAudioBus = jest.fn();
    const refusing = radioServiceWith({
      type: 'radio',
      radioSettings: { enabled: false },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true })],
      controllers: [ProgramController],
      providers: [
        // The renderer-write guard on the program writes; these tests do not call them.
        { provide: RendererAuthService, useValue: {} },
        { provide: PompeiiService, useValue: {} },
        {
          provide: ProgramService,
          useValue: {
            updateProgramAudioBus,
            refuseOperatorStartWhileEngineUnavailable: () =>
              refusing.refuseStartWhileEngineUnavailable('station'),
          },
        },
        { provide: FlightService, useValue: {} },
        { provide: ProgramTemplateService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(
        `${await app.getUrl()}/program/station/audio-bus`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            songSequence: sequence({ activeItemId: 'b' }),
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        reason: 'engine_unavailable',
        message:
          'The radio engine is off (disabled in settings), so nothing was taken.',
      });
      expect(updateProgramAudioBus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
