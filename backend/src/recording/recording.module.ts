import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlanaRecordingClient } from './alana-recording.client';
import { RecordingFileController } from './recording-file.controller';
import { RecordingDownloadTicketService } from './recording-download-ticket.service';
import { RecordingController } from './recording.controller';
import { TapeController } from './tape.controller';
import { RecordingMcpTools } from '../mcp/capabilities/recording';

@Module({
  imports: [ConfigModule],
  controllers: [RecordingController, TapeController, RecordingFileController],
  providers: [
    RecordingMcpTools,
    AlanaRecordingClient,
    RecordingDownloadTicketService,
  ],
  exports: [AlanaRecordingClient],
})
export class RecordingModule {}
