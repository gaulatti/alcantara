import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import {
  NowPlayingPublisherService,
  type NowPlayingConsumerPayload,
} from './now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import type { RadioSettingsPayload } from './radio.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('radio')
@RequirePermission(ALCANTARA_PERMISSIONS.radio.read)
export class RadioController {
  constructor(
    private readonly radioService: RadioService,
    private readonly songExecutionEngine: SongExecutionEngine,
    private readonly nowPlayingPublisherService: NowPlayingPublisherService,
    private readonly palazzoTelemetry: PalazzoRadioTelemetryService,
  ) {}

  @Get(':programId/settings')
  async getSettings(@Param('programId') programId: string) {
    return this.radioService.getRadioSettings(programId);
  }

  @Put(':programId/settings')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.manage)
  async updateSettings(
    @Param('programId') programId: string,
    @Body() data: RadioSettingsPayload,
  ) {
    const result = await this.radioService.updateRadioSettings(programId, data);
    await this.palazzoTelemetry.handleRadioSettingsChanged(programId);
    return result;
  }

  @Get(':programId/palazzo-status')
  async getPalazzoStatus(@Param('programId') programId: string) {
    return this.palazzoTelemetry.getStatus(programId);
  }

  @Get(':programId/now-playing-consumers')
  async listNowPlayingConsumers(@Param('programId') programId: string) {
    return this.nowPlayingPublisherService.listConsumers(programId);
  }

  @Put(':programId/now-playing-consumers')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.manage)
  async replaceNowPlayingConsumers(
    @Param('programId') programId: string,
    @Body() data: { consumers?: NowPlayingConsumerPayload[] },
  ) {
    if (!Array.isArray(data.consumers)) {
      throw new BadRequestException('consumers must be an array');
    }
    try {
      return await this.nowPlayingPublisherService.replaceConsumers(
        programId,
        data.consumers,
      );
    } catch (err) {
      throw new BadRequestException(String(err));
    }
  }

  @Post(':programId/song')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.operate)
  async playSong(
    @Param('programId') programId: string,
    @Body()
    data: {
      audioUrl: string;
      title?: string;
      artist?: string;
      coverUrl?: string;
      durationMs?: number;
    },
  ) {
    if (!data.audioUrl) {
      throw new BadRequestException('audioUrl is required');
    }
    this.songExecutionEngine.handleManualSong(
      programId,
      data.audioUrl,
      data.title,
      data.artist,
      data.durationMs,
      data.coverUrl,
    );
    return { ok: true };
  }

  @Post(':programId/song/stop')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.operate)
  async stopSong(@Param('programId') programId: string) {
    await this.radioService.stopSong(programId);
    this.songExecutionEngine.handleStopSong(programId);
    return { ok: true };
  }

  @Post(':programId/instant')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.operate)
  async playInstant(
    @Param('programId') programId: string,
    @Body() data: { audioUrl: string; instantId: number; volume?: number },
  ) {
    if (!data.audioUrl) {
      throw new BadRequestException('audioUrl is required');
    }
    await this.radioService.playInstant(programId, data.audioUrl, data.volume);
    return { ok: true };
  }

  @Post(':programId/instant/stop')
  @RequirePermission(ALCANTARA_PERMISSIONS.radio.operate)
  async stopAllInstants(@Param('programId') programId: string) {
    await this.radioService.stopAllInstants(programId);
    return { ok: true };
  }

  @Get(':programId/status')
  async getStatus(@Param('programId') programId: string) {
    return this.radioService.getPalazzoStatus(programId);
  }
}
