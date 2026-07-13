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
import type { RadioSettingsPayload } from './radio.service';

@Controller('radio')
export class RadioController {
  constructor(
    private readonly radioService: RadioService,
    private readonly songExecutionEngine: SongExecutionEngine,
  ) {}

  @Get(':programId/settings')
  async getSettings(@Param('programId') programId: string) {
    return this.radioService.getRadioSettings(programId);
  }

  @Put(':programId/settings')
  async updateSettings(
    @Param('programId') programId: string,
    @Body() data: RadioSettingsPayload,
  ) {
    return this.radioService.updateRadioSettings(programId, data);
  }

  @Post(':programId/song')
  async playSong(
    @Param('programId') programId: string,
    @Body() data: { audioUrl: string; title?: string; artist?: string; durationMs?: number },
  ) {
    if (!data.audioUrl) {
      throw new BadRequestException('audioUrl is required');
    }
    await this.radioService.playSong(programId, data.audioUrl, data.title, data.artist);
    this.songExecutionEngine.handleManualSong(programId, data.audioUrl, data.title, data.artist, data.durationMs);
    return { ok: true };
  }

  @Post(':programId/song/stop')
  async stopSong(@Param('programId') programId: string) {
    await this.radioService.stopSong(programId);
    this.songExecutionEngine.handleStopSong(programId);
    return { ok: true };
  }

  @Post(':programId/instant')
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
  async stopAllInstants(@Param('programId') programId: string) {
    await this.radioService.stopAllInstants(programId);
    return { ok: true };
  }

  @Get(':programId/status')
  async getStatus(@Param('programId') programId: string) {
    return this.radioService.getPalazzoStatus(programId);
  }
}
