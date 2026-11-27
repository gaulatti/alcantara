const mockPrismaPg = jest.fn();
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(...args: unknown[]) {
      mockPrismaPg(...args);
    }
  },
}));
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), {
  virtual: true,
});

import { ChartsService } from '../charts/charts.service';
import { DatabaseBackupService } from '../database-backup/database-backup.service';
import { MediaAnalysisService } from '../media-analysis/media-analysis.service';
import { MediaAssetsReconciliationService } from '../media-assets/media-assets-reconciliation.service';
import { createPostgresAdapter } from '../prisma-adapter';
import { FlightService } from '../program/flight.service';
import { ProgramService } from '../program/program.service';
import { PalazzoRadioTelemetryService } from '../radio/palazzo-telemetry.service';
import { SongSimilarityService } from '../radio/song-similarity.service';
import {
  DEPLOY_CANDIDATE_ENV,
  READ_ONLY_SESSION_OPTION,
  isDeployCandidate,
} from './deploy-candidate';

/**
 * gaulatti/alcantara#223: a deploy candidate boots the application but
 * writes, claims and schedules nothing. Each start-up hook below runs with
 * spies standing in for everything it would write or start; the clock is
 * then run well past every interval (the one-second rundown poll, the hourly
 * backup, the media-analysis delay) and nothing may have been called.
 */

type Hooked = Record<string, unknown>;
const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

function run<T>(prototype: T, hook: keyof T, self: Hooked): unknown {
  const fn = prototype[hook] as unknown as (this: Hooked) => unknown;
  return fn.call(self);
}

describe('deploy candidate mode', () => {
  const previous = process.env[DEPLOY_CANDIDATE_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[DEPLOY_CANDIDATE_ENV];
    else process.env[DEPLOY_CANDIDATE_ENV] = previous;
    jest.useRealTimers();
    mockPrismaPg.mockClear();
  });

  describe('the setting', () => {
    it('is off when unset and on only for 1', () => {
      expect(isDeployCandidate({})).toBe(false);
      expect(isDeployCandidate({ [DEPLOY_CANDIDATE_ENV]: '1' })).toBe(true);
    });

    it.each(['', '0', 'true', 'yes'])(
      'fails start-up for any other value (%p)',
      (value) => {
        expect(() =>
          isDeployCandidate({ [DEPLOY_CANDIDATE_ENV]: value }),
        ).toThrow(`${DEPLOY_CANDIDATE_ENV} must be 1 or unset`);
      },
    );

    it('reads the process environment by default', () => {
      delete process.env[DEPLOY_CANDIDATE_ENV];
      expect(isDeployCandidate()).toBe(false);
      process.env[DEPLOY_CANDIDATE_ENV] = '1';
      expect(isDeployCandidate()).toBe(true);
    });
  });

  describe('the database connection', () => {
    it('is unchanged for a normal instance', () => {
      createPostgresAdapter('postgres://u:p@h:5432/db');
      expect(mockPrismaPg).toHaveBeenCalledWith(
        { connectionString: 'postgres://u:p@h:5432/db' },
        { schema: 'public' },
      );
    });

    it('opens read-only sessions for a candidate', () => {
      createPostgresAdapter('postgres://u:p@h:5432/db?schema=s', {
        readOnly: true,
      });
      const [[{ connectionString }]] = mockPrismaPg.mock.calls as [
        [{ connectionString: string }],
      ];
      const url = new URL(connectionString);
      expect(url.searchParams.get('options')).toBe(READ_ONLY_SESSION_OPTION);
      expect(url.searchParams.has('schema')).toBe(false);
    });

    it('keeps options the address already carries, read-only last', () => {
      createPostgresAdapter(
        'postgres://u:p@h:5432/db?options=-c%20statement_timeout%3D5000',
        { readOnly: true },
      );
      const [[{ connectionString }]] = mockPrismaPg.mock.calls as [
        [{ connectionString: string }],
      ];
      expect(new URL(connectionString).searchParams.get('options')).toBe(
        `-c statement_timeout=5000 ${READ_ONLY_SESSION_OPTION}`,
      );
    });
  });

  describe('the start-up writers and schedulers', () => {
    beforeEach(() => {
      process.env[DEPLOY_CANDIDATE_ENV] = '1';
      jest.useFakeTimers();
    });

    const afterTimers = async () => {
      await jest.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(jest.getTimerCount()).toBe(0);
    };

    it('leaves rundown blocks as they are and starts none', async () => {
      const updateMany = jest.fn();
      const self: Hooked = {
        logger: logger(),
        prisma: { flightSequence: { updateMany } },
        startDuePublishedLogs: jest.fn(),
      };
      await run(FlightService.prototype, 'onModuleInit', self);
      await afterTimers();
      expect(updateMany).not.toHaveBeenCalled();
      expect(self.startDuePublishedLogs).not.toHaveBeenCalled();
      expect(self.scheduleTimer).toBeUndefined();
    });

    it('validates the backup configuration but schedules no backup', async () => {
      const self: Hooked = {
        logger: logger(),
        isProduction: () => true,
        productionConfiguration: jest.fn(),
        scheduleNextBackup: jest.fn(),
      };
      await run(DatabaseBackupService.prototype, 'onModuleInit', self);
      await afterTimers();
      expect(self.productionConfiguration).toHaveBeenCalledTimes(1);
      expect(self.scheduleNextBackup).not.toHaveBeenCalled();
    });

    it('schedules no media analysis', async () => {
      const self: Hooked = {
        logger: logger(),
        analyzer: { available: jest.fn() },
        schedule: jest.fn(),
      };
      await run(MediaAnalysisService.prototype, 'onApplicationBootstrap', self);
      await afterTimers();
      expect(
        (self.analyzer as { available: jest.Mock }).available,
      ).not.toHaveBeenCalled();
      expect(self.schedule).not.toHaveBeenCalled();
    });

    it('does not reconcile media assets', async () => {
      const self: Hooked = { logger: logger(), reconcile: jest.fn() };
      await run(
        MediaAssetsReconciliationService.prototype,
        'onApplicationBootstrap',
        self,
      );
      expect(self.reconcile).not.toHaveBeenCalled();
    });

    it('starts no Palazzo telemetry', async () => {
      const self: Hooked = {
        logger: logger(),
        engine: { setPalazzoTelemetry: jest.fn() },
        startAll: jest.fn(),
      };
      await run(PalazzoRadioTelemetryService.prototype, 'onModuleInit', self);
      expect(self.startAll).not.toHaveBeenCalled();
    });

    it('writes no default program state', async () => {
      const self: Hooked = {
        outputConfidence: {},
        songExecutionEngine: {
          setBroadcastHandler: jest.fn(),
          trackEvents$: { subscribe: jest.fn(() => ({ unsubscribe() {} })) },
        },
        ensureDefaultProgramState: jest.fn(),
      };
      await run(ProgramService.prototype, 'onModuleInit', self);
      expect(self.ensureDefaultProgramState).not.toHaveBeenCalled();
    });

    it('polls no chart feed', async () => {
      const self: Hooked = {
        logger: logger(),
        pollingEnabled: jest.fn(() => true),
        refreshCache: jest.fn(),
      };
      run(ChartsService.prototype, 'onModuleInit', self);
      await afterTimers();
      expect(self.refreshCache).not.toHaveBeenCalled();
    });

    it('loads the similarity settings but never refreshes the catalog', async () => {
      const self: Hooked = {
        logger: logger(),
        settings: new Map(),
        vectors: new Map(),
        catalog: new Map(),
        markReady: jest.fn(),
        reloadSettings: jest.fn(() => Promise.resolve()),
        anyActive: () => true,
        reloadEmbeddings: jest.fn(() => Promise.resolve()),
        // The hook starts the load and returns; the load is the real one.
        load: (SongSimilarityService.prototype as unknown as { load: unknown })
          .load,
      };
      await run(SongSimilarityService.prototype, 'onModuleInit', self);
      await afterTimers();
      expect(self.reloadSettings).toHaveBeenCalledTimes(1);
      expect(self.reloadEmbeddings).toHaveBeenCalledTimes(1);
      // The first load is done: the engine may announce from the index (#277).
      expect(self.markReady).toHaveBeenCalledTimes(1);
    });
  });
});
