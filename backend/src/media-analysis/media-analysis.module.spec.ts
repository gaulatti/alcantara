import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { FfmpegAudioAnalyzer } from './ffmpeg-audio.analyzer';
import { MediaAnalysisMetrics } from './media-analysis.metrics';
import { MediaAnalysisModule } from './media-analysis.module';
import {
  MEDIA_AUDIO_ANALYZER,
  MediaAnalysisService,
} from './media-analysis.service';

describe('MediaAnalysisModule wiring', () => {
  it('provides the job, its metrics, Prisma and the ffmpeg analyzer', () => {
    const providers = Reflect.getMetadata(
      'providers',
      MediaAnalysisModule,
    ) as Array<unknown>;
    expect(providers.slice(0, 3)).toEqual([
      MediaAnalysisService,
      MediaAnalysisMetrics,
      PrismaService,
    ]);
    const analyzer = providers[3] as {
      provide: symbol;
      useFactory: (managed: ManagedMetricsService) => unknown;
      inject: unknown[];
    };
    expect(analyzer.provide).toBe(MEDIA_AUDIO_ANALYZER);
    expect(analyzer.inject).toEqual([ManagedMetricsService]);
    const managed = { recordOutboundFetch: jest.fn() };
    const built = analyzer.useFactory(
      managed as unknown as ManagedMetricsService,
    ) as FfmpegAudioAnalyzer;
    expect(built).toBeInstanceOf(FfmpegAudioAnalyzer);
    // The analyzer's input check reports to the shared outbound counter.
    built['policy'].record?.('media_analysis', 'address');
    expect(managed.recordOutboundFetch).toHaveBeenCalledWith(
      'media_analysis',
      'address',
    );
    expect(
      Reflect.getMetadata('controllers', MediaAnalysisModule),
    ).toBeUndefined();
  });
});
