/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Jest mocks are intentionally loosely typed. */
import { BadRequestException, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { AsRunService, escapeCsvField } from './as-run.service';
import {
  SOUNDEXCHANGE_SPECIFICATION_VERSION,
  type AsRunTrackEvent,
} from './as-run.types';
import type { PrismaService } from '../prisma.service';
import type { RadioMetricsService } from '../radio/radio-metrics.service';
import type { SongExecutionEngine } from '../radio/song-execution.engine';

describe('AsRunService', () => {
  let prisma: {
    asRunRecord: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    song: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    mediaAsset: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let radioMetrics: {
    recordRadioLogResult: jest.Mock;
  };
  let service: AsRunService;

  beforeEach(() => {
    prisma = {
      asRunRecord: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 1,
            ...data,
            createdAt: new Date('2026-11-15T00:00:00Z'),
          }),
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      song: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      mediaAsset: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    radioMetrics = {
      recordRadioLogResult: jest.fn(),
    };
    service = new AsRunService(
      prisma as unknown as PrismaService,
      undefined,
      radioMetrics as unknown as RadioMetricsService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('escapeCsvField helper', () => {
    it('handles null, undefined, normal text, and special characters', () => {
      expect(escapeCsvField(null)).toBe('');
      expect(escapeCsvField(undefined)).toBe('');
      expect(escapeCsvField('simple')).toBe('simple');
      expect(escapeCsvField(123)).toBe('123');
      expect(escapeCsvField(true)).toBe('true');
      expect(escapeCsvField(new Date('2026-11-15T00:00:00.000Z'))).toBe(
        '2026-11-15T00:00:00.000Z',
      );
      expect(escapeCsvField('has,comma')).toBe('"has,comma"');
      expect(escapeCsvField('has"quote')).toBe('"has""quote"');
      expect(escapeCsvField('has\nnewline')).toBe('"has\nnewline"');
      expect(escapeCsvField('has\rreturn')).toBe('"has\rreturn"');
    });
  });

  describe('onModuleInit and onModuleDestroy', () => {
    it('does not subscribe when engine is undefined', () => {
      service.onModuleInit();
      // Should not throw and subscription is undefined
      service.onModuleDestroy();
    });

    it('does not subscribe when engine lacks trackEvents$', () => {
      const standInEngine = {} as SongExecutionEngine;
      const s = new AsRunService(
        prisma as unknown as PrismaService,
        standInEngine,
        radioMetrics as unknown as RadioMetricsService,
      );
      s.onModuleInit();
      s.onModuleDestroy();
    });

    it('does not subscribe when trackEvents$ is null or not a subscriable object', () => {
      const standInEngine1 = {
        trackEvents$: null,
      } as unknown as SongExecutionEngine;
      const s1 = new AsRunService(
        prisma as unknown as PrismaService,
        standInEngine1,
        radioMetrics as unknown as RadioMetricsService,
      );
      s1.onModuleInit();
      s1.onModuleDestroy();

      const standInEngine2 = {
        trackEvents$: {},
      } as unknown as SongExecutionEngine;
      const s2 = new AsRunService(
        prisma as unknown as PrismaService,
        standInEngine2,
        radioMetrics as unknown as RadioMetricsService,
      );
      s2.onModuleInit();
      s2.onModuleDestroy();
    });

    it('subscribes and handles events when engine has trackEvents$', async () => {
      const subject = new Subject<AsRunTrackEvent>();
      const standInEngine = {
        trackEvents$: subject.asObservable(),
      } as unknown as SongExecutionEngine;

      const s = new AsRunService(
        prisma as unknown as PrismaService,
        standInEngine,
        radioMetrics as unknown as RadioMetricsService,
      );
      s.onModuleInit();

      const event: AsRunTrackEvent = {
        programId: 'radio-1',
        type: 'track.started',
        playbackRequestId: 'req-1',
        title: 'Song 1',
        artist: 'Artist 1',
        url: 'https://cdn.example.test/song1.mp3',
        at: new Date('2026-11-15T01:00:00Z'),
      };

      prisma.song.findFirst.mockResolvedValueOnce({
        id: 101,
        assetId: 'asset-101',
      });

      subject.next(event);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(prisma.asRunRecord.create).toHaveBeenCalledWith({
        data: {
          programId: 'radio-1',
          songId: 101,
          assetId: 'asset-101',
          state: 'started',
          at: new Date('2026-11-15T01:00:00Z'),
          playbackRequestId: 'req-1',
          inferred: false,
          reviewFlag: null,
        },
      });

      s.onModuleDestroy();
    });

    it('logs error when trackEvents$ observable errors', () => {
      const subject = new Subject<AsRunTrackEvent>();
      const standInEngine = {
        trackEvents$: subject.asObservable(),
      } as unknown as SongExecutionEngine;

      const s = new AsRunService(
        prisma as unknown as PrismaService,
        standInEngine,
        radioMetrics as unknown as RadioMetricsService,
      );
      const loggerSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});

      s.onModuleInit();
      subject.error(new Error('Observable stream failure'));

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error in trackEvents$ stream'),
      );
      loggerSpy.mockRestore();
      s.onModuleDestroy();
    });
  });

  describe('handleTrackEvent', () => {
    it('ignores invalid event structures', async () => {
      expect(
        await service.handleTrackEvent(null as unknown as AsRunTrackEvent),
      ).toBeNull();
      expect(
        await service.handleTrackEvent({
          programId: '',
          type: 'track.started',
        } as AsRunTrackEvent),
      ).toBeNull();
      expect(
        await service.handleTrackEvent({
          programId: 'p1',
          type: 'unknown' as unknown as 'track.started',
        } as AsRunTrackEvent),
      ).toBeNull();
    });

    it('records track.ended and reports completed metric', async () => {
      const event: AsRunTrackEvent = {
        programId: 'radio-1',
        type: 'track.ended',
        playbackRequestId: 'req-end',
        title: null,
        artist: null,
        url: 'https://cdn.example.test/unknown.mp3',
        at: new Date('2026-11-15T01:03:00Z'),
      };

      const result = await service.handleTrackEvent(event);
      expect(result).toBeDefined();
      expect(prisma.asRunRecord.create).toHaveBeenCalledWith({
        data: {
          programId: 'radio-1',
          songId: null,
          assetId: null,
          state: 'ended',
          at: new Date('2026-11-15T01:03:00Z'),
          playbackRequestId: 'req-end',
          inferred: false,
          reviewFlag: null,
        },
      });
      expect(radioMetrics.recordRadioLogResult).toHaveBeenCalledWith(
        'completed',
      );
    });

    it('handles at timestamp passed as string or non-Date', async () => {
      const event = {
        programId: 'radio-1',
        type: 'track.started' as const,
        playbackRequestId: 'req-str',
        title: null,
        artist: null,
        url: null,
        at: '2026-11-15T02:00:00Z' as unknown as Date,
      };

      await service.handleTrackEvent(event);
      expect(prisma.asRunRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            at: new Date('2026-11-15T02:00:00Z'),
          }),
        }),
      );
    });
  });

  describe('resolveSongAndAsset', () => {
    it('matches song by audioUrl', async () => {
      prisma.song.findFirst.mockResolvedValueOnce({
        id: 42,
        assetId: 'asset-42',
      });

      const res = await service.resolveSongAndAsset({
        programId: 'p1',
        type: 'track.started',
        playbackRequestId: 'r',
        title: 'Other Title',
        artist: 'Other Artist',
        url: 'https://audio.test/song.mp3',
        at: new Date(),
      });

      expect(res).toEqual({ songId: 42, assetId: 'asset-42' });
      expect(prisma.song.findFirst).toHaveBeenCalledWith({
        where: { audioUrl: 'https://audio.test/song.mp3' },
        select: { id: true, assetId: true },
      });
    });

    it('matches media asset by sourceUrl when song is not found', async () => {
      prisma.song.findFirst.mockResolvedValueOnce(null);
      prisma.mediaAsset.findFirst.mockResolvedValueOnce({ id: 'ma-77' });

      const res = await service.resolveSongAndAsset({
        programId: 'p1',
        type: 'track.started',
        playbackRequestId: 'r',
        title: null,
        artist: null,
        url: 'https://audio.test/bumper.mp3',
        at: new Date(),
      });

      expect(res).toEqual({ songId: null, assetId: 'ma-77' });
      expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith({
        where: { sourceUrl: 'https://audio.test/bumper.mp3' },
        select: { id: true },
      });
    });

    it('matches song by title and artist when URL does not match', async () => {
      prisma.song.findFirst
        .mockResolvedValueOnce(null) // audioUrl lookup
        .mockResolvedValueOnce({ id: 88, assetId: 'asset-88' }); // title/artist lookup
      prisma.mediaAsset.findFirst.mockResolvedValueOnce(null);

      const res = await service.resolveSongAndAsset({
        programId: 'p1',
        type: 'track.started',
        playbackRequestId: 'r',
        title: 'Title X',
        artist: 'Artist X',
        url: 'https://audio.test/stream.mp3',
        at: new Date(),
      });

      expect(res).toEqual({ songId: 88, assetId: 'asset-88' });
      expect(prisma.song.findFirst).toHaveBeenCalledWith({
        where: { title: 'Title X', artist: 'Artist X' },
        select: { id: true, assetId: true },
      });
    });

    it('matches song by title and artist when no URL is provided', async () => {
      prisma.song.findFirst.mockResolvedValueOnce({ id: 99, assetId: null });

      const res = await service.resolveSongAndAsset({
        programId: 'p1',
        type: 'track.started',
        playbackRequestId: 'r',
        title: 'Title Y',
        artist: 'Artist Y',
        url: null,
        at: new Date(),
      });

      expect(res).toEqual({ songId: 99, assetId: null });
      expect(prisma.song.findFirst).toHaveBeenCalledWith({
        where: { title: 'Title Y', artist: 'Artist Y' },
        select: { id: true, assetId: true },
      });
    });

    it('returns nulls when neither url nor metadata matches', async () => {
      prisma.song.findFirst.mockResolvedValue(null);
      prisma.mediaAsset.findFirst.mockResolvedValue(null);

      const res = await service.resolveSongAndAsset({
        programId: 'p1',
        type: 'track.started',
        playbackRequestId: 'r',
        title: null,
        artist: null,
        url: null,
        at: new Date(),
      });

      expect(res).toEqual({ songId: null, assetId: null });
    });
  });

  describe('record', () => {
    it('creates record with normalized songId and assetId', async () => {
      await service.record({
        programId: 'prog-1',
        songId: 15,
        assetId: 'asset-15',
        state: 'started',
        at: new Date('2026-11-15T03:00:00Z'),
      });

      expect(prisma.asRunRecord.create).toHaveBeenCalledWith({
        data: {
          programId: 'prog-1',
          songId: 15,
          assetId: 'asset-15',
          state: 'started',
          at: new Date('2026-11-15T03:00:00Z'),
        },
      });
    });

    it('normalizes string integer or non-integer songId and non-string assetId', async () => {
      await service.record({
        programId: 'prog-1',
        songId: 3.14 as unknown as number,
        assetId: '' as unknown as string,
        state: 'ended',
        at: '2026-11-15T03:05:00Z' as unknown as Date,
      });

      expect(prisma.asRunRecord.create).toHaveBeenCalledWith({
        data: {
          programId: 'prog-1',
          songId: null,
          assetId: null,
          state: 'ended',
          at: new Date('2026-11-15T03:05:00Z'),
        },
      });
      expect(radioMetrics.recordRadioLogResult).toHaveBeenCalledWith(
        'completed',
      );
    });
  });

  describe('parseExportDates and export validation', () => {
    it('parses valid ISO date strings', () => {
      const dates = service.parseExportDates({
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-15T23:59:59.999Z',
      });
      expect(dates.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(dates.to?.toISOString()).toBe('2026-11-15T23:59:59.999Z');
    });

    it('leaves dates undefined when omitted', () => {
      const dates = service.parseExportDates({});
      expect(dates.from).toBeUndefined();
      expect(dates.to).toBeUndefined();
    });

    it('throws BadRequestException on invalid from date', () => {
      expect(() => service.parseExportDates({ from: 'not-a-date' })).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException on invalid to date', () => {
      expect(() => service.parseExportDates({ to: 'invalid-date' })).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException on unsupported export format', async () => {
      await expect(
        service.export('p1', { format: 'unsupported' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('defaults format to csv and the window to the last 31 days when omitted', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-21T00:00:00Z') });
      const spy = jest
        .spyOn(service, 'exportCsv')
        .mockResolvedValueOnce('csv-data');
      const res = await service.export('p1', {});
      jest.useRealTimers();
      expect(res).toBe('csv-data');
      expect(spy).toHaveBeenCalledWith(
        'p1',
        new Date('2026-10-21T00:00:00Z'),
        undefined,
      );
    });

    it('delegates to exportSoundExchange when format is soundexchange', async () => {
      const spy = jest
        .spyOn(service, 'exportSoundExchange')
        .mockResolvedValueOnce('sx-data');
      const res = await service.export('p1', {
        format: 'soundexchange',
        to: '2026-11-11T00:00:00Z',
      });
      expect(res).toBe('sx-data');
      expect(spy).toHaveBeenCalledWith(
        'p1',
        new Date('2026-10-11T00:00:00Z'),
        new Date('2026-11-11T00:00:00Z'),
        'include',
      );
    });
  });

  describe('exportCsv', () => {
    it('exports all records with song lookup and escaped fields', async () => {
      const records = [
        {
          id: 1,
          programId: 'radio-1',
          songId: 10,
          assetId: 'asset-10',
          state: 'started',
          at: new Date('2026-11-15T10:00:00.000Z'),
          createdAt: new Date('2026-11-15T10:00:00.000Z'),
        },
        {
          id: 2,
          programId: 'radio-1',
          songId: 10,
          assetId: 'asset-10',
          state: 'ended',
          at: new Date('2026-11-15T10:03:30.000Z'),
          createdAt: new Date('2026-11-15T10:03:30.000Z'),
        },
        {
          id: 3,
          programId: 'radio-1',
          songId: 999, // deleted song
          assetId: null,
          state: 'started',
          at: new Date('2026-11-15T10:04:00.000Z'),
          createdAt: new Date('2026-11-15T10:04:00.000Z'),
        },
        {
          id: 4,
          programId: 'radio-1',
          songId: null,
          assetId: 'ad,1', // comma in assetId to test escaping
          state: 'started',
          at: new Date('2026-11-15T10:05:00.000Z'),
          createdAt: new Date('2026-11-15T10:05:00.000Z'),
        },
        {
          id: 5,
          programId: 'radio-1',
          songId: 11,
          assetId: null,
          state: 'ended',
          at: new Date('2026-11-15T10:06:00.000Z'),
          createdAt: new Date('2026-11-15T10:06:00.000Z'),
        },
      ];

      prisma.asRunRecord.findMany.mockResolvedValueOnce(records);
      prisma.song.findMany.mockResolvedValueOnce([
        { id: 10, title: 'Hello, World', artist: 'The "Artists"' },
        { id: 11, title: 'Multi\nLine\rTitle', artist: 'Artist\r' },
      ]);

      const csv = await service.exportCsv(
        'radio-1',
        new Date('2026-11-15T00:00:00Z'),
        new Date('2026-11-15T23:59:59Z'),
      );

      const lines = csv.split('\n');
      expect(lines[0]).toBe(
        'id,programId,songId,assetId,title,artist,state,at,createdAt,inferred,reviewFlag,endReason,actorPrincipalId,actorVia,actorClient',
      );
      // Row 1: Song 10 with comma and quote escaping
      expect(lines[1]).toBe(
        '1,radio-1,10,asset-10,"Hello, World","The ""Artists""",started,2026-11-15T10:00:00.000Z,2026-11-15T10:00:00.000Z,false,,,,,',
      );
      // Row 3: Deleted song 999 retains songId scalar, title/artist empty
      expect(lines[3]).toBe(
        '3,radio-1,999,,,,started,2026-11-15T10:04:00.000Z,2026-11-15T10:04:00.000Z,false,,,,,',
      );
      // Row 4: assetId with comma escaped
      expect(lines[4]).toBe(
        '4,radio-1,,"ad,1",,,started,2026-11-15T10:05:00.000Z,2026-11-15T10:05:00.000Z,false,,,,,',
      );
    });

    it('returns only header when no records found', async () => {
      prisma.asRunRecord.findMany.mockResolvedValueOnce([]);

      const csv = await service.exportCsv('radio-empty');
      expect(csv).toBe(
        'id,programId,songId,assetId,title,artist,state,at,createdAt,inferred,reviewFlag,endReason,actorPrincipalId,actorVia,actorClient',
      );
      expect(prisma.song.findMany).not.toHaveBeenCalled();
    });
  });

  describe('exportSoundExchange', () => {
    it('matches published SoundExchange layout columns and lists missing ISRCs as gaps', async () => {
      const records = [
        // Song 1 played twice
        {
          id: 2,
          programId: 'radio-1',
          songId: 1,
          assetId: 'asset-1',
          state: 'ended',
          at: new Date('2026-11-15T10:03:00.000Z'),
          createdAt: new Date('2026-11-15T10:03:00.000Z'),
        },
        {
          id: 4,
          programId: 'radio-1',
          songId: 1,
          assetId: 'asset-1',
          state: 'ended',
          at: new Date('2026-11-15T11:03:00.000Z'),
          createdAt: new Date('2026-11-15T11:03:00.000Z'),
        },
        // Asset without song played once
        {
          id: 6,
          programId: 'radio-1',
          songId: null,
          assetId: 'asset-jingle',
          state: 'ended',
          at: new Date('2026-11-15T12:00:30.000Z'),
          createdAt: new Date('2026-11-15T12:00:30.000Z'),
        },
        // Unidentified play
        {
          id: 8,
          programId: 'radio-1',
          songId: null,
          assetId: null,
          state: 'ended',
          at: new Date('2026-11-15T12:30:00.000Z'),
          createdAt: new Date('2026-11-15T12:30:00.000Z'),
        },
      ];

      prisma.asRunRecord.findMany.mockResolvedValueOnce(records);
      prisma.song.findMany.mockResolvedValueOnce([
        { id: 1, title: 'Summer Breeze', artist: 'Seals & Crofts' },
      ]);
      prisma.mediaAsset.findMany.mockResolvedValueOnce([
        { id: 'asset-jingle', name: 'Station Jingle' },
      ]);

      const sx = await service.exportSoundExchange(
        'radio-1',
        new Date('2026-11-15T00:00:00Z'),
        new Date('2026-11-15T23:59:59Z'),
      );

      const lines = sx.split('\n');
      expect(lines[0]).toBe(
        'Transmission Category Code,Featured Artist Name,Sound Recording Title,ISRC,Album Title,Marketing Label,Actual Total Performances',
      );
      // Row 1: Seals & Crofts played 2 times, ISRC is empty gap
      expect(lines[1]).toBe('E,Seals & Crofts,Summer Breeze,,,,2');
      // Row 2: Asset jingle played 1 time, ISRC is empty gap
      expect(lines[2]).toBe('E,,Station Jingle,,,,1');
      // Row 3: Unidentified record played 1 time
      expect(lines[3]).toBe('E,,,,,,1');
    });

    it('returns header only when no ended plays in range', async () => {
      expect(SOUNDEXCHANGE_SPECIFICATION_VERSION).toContain('37 CFR § 370.4');
      prisma.asRunRecord.findMany.mockResolvedValueOnce([]);

      const sx = await service.exportSoundExchange('radio-empty');
      expect(sx).toBe(
        'Transmission Category Code,Featured Artist Name,Sound Recording Title,ISRC,Album Title,Marketing Label,Actual Total Performances',
      );
    });
  });

  describe('telemetry fixture replay and interrupted track recording', () => {
    it('yields exact play counts and records interrupted track as ended with real position', async () => {
      const fixtureTelemetryEvents: AsRunTrackEvent[] = [
        // Track 1: full play (duration 180s)
        {
          programId: 'radio-live',
          type: 'track.started',
          playbackRequestId: 'play-1',
          title: 'Full Track',
          artist: 'Artist 1',
          url: 'https://audio.test/t1.mp3',
          at: new Date('2026-11-15T14:00:00.000Z'),
        },
        {
          programId: 'radio-live',
          type: 'track.ended',
          playbackRequestId: 'play-1',
          title: 'Full Track',
          artist: 'Artist 1',
          url: 'https://audio.test/t1.mp3',
          at: new Date('2026-11-15T14:03:00.000Z'),
        },
        // Track 2: interrupted early at 42 seconds (nominal duration 240s)
        {
          programId: 'radio-live',
          type: 'track.started',
          playbackRequestId: 'play-2',
          title: 'Interrupted Track',
          artist: 'Artist 2',
          url: 'https://audio.test/t2.mp3',
          at: new Date('2026-11-15T14:03:00.000Z'),
        },
        {
          programId: 'radio-live',
          type: 'track.ended',
          playbackRequestId: 'play-2',
          title: 'Interrupted Track',
          artist: 'Artist 2',
          url: 'https://audio.test/t2.mp3',
          at: new Date('2026-11-15T14:03:42.000Z'), // real position of interruption
        },
        // Track 3: subsequent track played to end
        {
          programId: 'radio-live',
          type: 'track.started',
          playbackRequestId: 'play-3',
          title: 'Subsequent Track',
          artist: 'Artist 3',
          url: 'https://audio.test/t3.mp3',
          at: new Date('2026-11-15T14:03:42.000Z'),
        },
        {
          programId: 'radio-live',
          type: 'track.ended',
          playbackRequestId: 'play-3',
          title: 'Subsequent Track',
          artist: 'Artist 3',
          url: 'https://audio.test/t3.mp3',
          at: new Date('2026-11-15T14:06:42.000Z'),
        },
      ];

      const recordedRows: {
        id: number;
        programId: string;
        songId: number | null;
        assetId: string | null;
        state: string;
        at: Date;
        createdAt: Date;
      }[] = [];

      let nextId = 1;
      prisma.asRunRecord.create.mockImplementation(({ data }) => {
        const row = { id: nextId++, ...data, createdAt: new Date() };
        recordedRows.push(row);
        return Promise.resolve(row);
      });

      // Replay telemetry fixture
      for (const event of fixtureTelemetryEvents) {
        await service.handleTrackEvent(event);
      }

      // Exact count verification
      const startedEvents = recordedRows.filter((r) => r.state === 'started');
      const endedEvents = recordedRows.filter((r) => r.state === 'ended');

      expect(startedEvents).toHaveLength(3);
      expect(endedEvents).toHaveLength(3);

      // Verify interrupted track is recorded as 'ended' with its real position (14:03:42, exactly 42s after start)
      const interruptedStart = recordedRows.find(
        (r) =>
          r.state === 'started' &&
          r.at.toISOString() === '2026-11-15T14:03:00.000Z',
      );
      const interruptedEnd = recordedRows.find(
        (r) =>
          r.state === 'ended' &&
          r.at.toISOString() === '2026-11-15T14:03:42.000Z',
      );

      expect(interruptedStart).toBeDefined();
      expect(interruptedEnd).toBeDefined();
      expect(interruptedEnd?.state).toBe('ended');
      expect(
        interruptedEnd!.at.getTime() - interruptedStart!.at.getTime(),
      ).toBe(42000);
    });
  });

  describe('scalar id history preservation on song deletion', () => {
    it('preserves as-run history when a song is deleted', async () => {
      // Simulate existing as-run records for song 77
      const asRunRows = [
        {
          id: 10,
          programId: 'radio-1',
          songId: 77,
          assetId: 'asset-77',
          state: 'started',
          at: new Date('2026-11-15T15:00:00.000Z'),
          createdAt: new Date('2026-11-15T15:00:00.000Z'),
        },
        {
          id: 11,
          programId: 'radio-1',
          songId: 77,
          assetId: 'asset-77',
          state: 'ended',
          at: new Date('2026-11-15T15:03:00.000Z'),
          createdAt: new Date('2026-11-15T15:03:00.000Z'),
        },
      ];

      // Song 77 was deleted, so prisma.song.findMany returns empty list
      prisma.asRunRecord.findMany.mockResolvedValueOnce(asRunRows);
      prisma.song.findMany.mockResolvedValueOnce([]);

      const csv = await service.exportCsv('radio-1');

      // As-run records still retain songId 77 and assetId asset-77
      expect(csv).toContain('10,radio-1,77,asset-77,,,started');
      expect(csv).toContain('11,radio-1,77,asset-77,,,ended');

      // Exporting SoundExchange with deleted song still produces performance count
      prisma.asRunRecord.findMany.mockResolvedValueOnce([asRunRows[1]]);
      prisma.song.findMany.mockResolvedValueOnce([]);
      prisma.mediaAsset.findMany.mockResolvedValueOnce([]);

      const sx = await service.exportSoundExchange('radio-1');
      expect(sx).toContain('E,,,,,,1');
    });
  });
});
