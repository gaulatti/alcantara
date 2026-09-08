import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlanaRecordingClient } from './alana-recording.client';
import { RecordingController } from './recording.controller';

@Module({
  imports: [ConfigModule],
  controllers: [RecordingController],
  providers: [AlanaRecordingClient],
  exports: [AlanaRecordingClient],
})
export class RecordingModule {}
