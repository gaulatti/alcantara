import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { FfmpegAudioAnalyzer } from './ffmpeg-audio.analyzer';
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
      useFactory: () => new FfmpegAudioAnalyzer(),
    },
  ],
})
export class MediaAnalysisModule {}
