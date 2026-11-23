import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { MediaImportMcpTools } from '../mcp/capabilities/media-import';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, MediaImportMcpTools],
})
export class UploadsModule {}
