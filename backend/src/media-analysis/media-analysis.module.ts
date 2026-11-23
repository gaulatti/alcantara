import { Module } from '@nestjs/common';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { PrismaService } from '../prisma.service';
import { FfmpegAudioAnalyzer } from './ffmpeg-audio.analyzer';
import { createProcessRunner } from './process-runner';
import { MediaAnalysisMetrics } from './media-analysis.metrics';
import {
  MEDIA_AUDIO_ANALYZER,
  MediaAnalysisService,
} from './media-analysis.service';

@Module({
  providers: [
    MediaAnalysisService,
    MediaAnalysisMetrics,
    PrismaService,
    {
      provide: MEDIA_AUDIO_ANALYZER,
      useFactory: (managed: ManagedMetricsService) =>
        new FfmpegAudioAnalyzer(createProcessRunner(), {
          record: (path, result) => managed.recordOutboundFetch(path, result),
        }),
      inject: [ManagedMetricsService],
    },
  ],
})
export class MediaAnalysisModule {}
