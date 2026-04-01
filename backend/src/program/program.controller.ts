import {
  Controller,
  Get,
  Post,
  Body,
  Sse,
  Param,
  Delete,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ProgramService } from './program.service';

@Controller('program')
export class ProgramController {
  constructor(private readonly programService: ProgramService) {}

  @Get()
  async listPrograms() {
    return this.programService.listPrograms();
  }

  @Post()
  async createProgram(@Body() data: { programId: string }) {
    return this.programService.createProgram(data.programId);
  }

  @Put(':programId')
  async renameProgram(
    @Param('programId') programId: string,
    @Body() data: { nextProgramId: string },
  ) {
    return this.programService.renameProgram(programId, data.nextProgramId);
  }

  @Delete(':programId')
  async deleteProgram(@Param('programId') programId: string) {
    return this.programService.deleteProgram(programId);
  }

  @Get('broadcast-settings')
  async getBroadcastSettings() {
    return this.programService.getBroadcastSettings();
  }

  @Put('broadcast-settings')
  async updateBroadcastSettings(
    @Body()
    data: {
      enabled?: boolean;
      startTime?: string | null;
      mixerChannels?: unknown;
      mainMasterVolume?: number;
      songMasterVolume?: number;
      instantMasterVolume?: number;
      streamMasterVolume?: number;
      sceneInstantMasterVolume?: number;
      songMuted?: boolean;
      instantMuted?: boolean;
      streamMuted?: boolean;
      sceneInstantMuted?: boolean;
      songSolo?: boolean;
      instantSolo?: boolean;
      streamSolo?: boolean;
      sceneInstantSolo?: boolean;
    },
  ) {
    return this.programService.updateBroadcastSettings(data);
  }

  @Get(':programId/state')
  async getStateById(@Param('programId') programId: string) {
    return this.programService.getState(programId);
  }

  @Get(':programId/audio-bus')
  async getProgramAudioBusById(@Param('programId') programId: string) {
    return this.programService.getProgramAudioBus(programId);
  }

  @Get(':programId/audio-meter')
  async getProgramAudioMeterById(@Param('programId') programId: string) {
    return this.programService.getProgramAudioMeter(programId);
  }

  @Post(':programId/audio-meter')
  async updateProgramAudioMeterById(
    @Param('programId') programId: string,
    @Body()
    data: {
      song?: unknown;
      instants?: unknown;
      sceneInstant?: unknown;
      main?: unknown;
    },
  ) {
    return this.programService.updateProgramAudioMeter(data, programId);
  }

  @Get(':programId/scene-instant')
  async getProgramSceneInstantById(@Param('programId') programId: string) {
    return this.programService.getProgramSceneInstantPlayback(programId);
  }

  @Post(':programId/scene-instant/take')
  async takeProgramSceneInstantById(
    @Param('programId') programId: string,
    @Body() data?: { sceneId?: number | null },
  ) {
    const sceneId =
      typeof data?.sceneId === 'number' && Number.isFinite(data.sceneId)
        ? data.sceneId
        : null;
    return this.programService.takeProgramSceneInstant(sceneId, programId);
  }

  @Post(':programId/scene-instant/stop')
  async stopProgramSceneInstantById(@Param('programId') programId: string) {
    return this.programService.stopProgramSceneInstant(programId);
  }

  @Get(':programId/song-playback')
  async getProgramSongPlaybackById(@Param('programId') programId: string) {
    return this.programService.getProgramSongPlayback(programId);
  }

  @Post(':programId/song-playback')
  async updateProgramSongPlaybackById(
    @Param('programId') programId: string,
    @Body()
    data: {
      token?: string;
      audioUrl?: string;
      progress?: number;
      currentTimeMs?: number;
      durationMs?: number | null;
      isPlaying?: boolean;
    },
  ) {
    return this.programService.updateProgramSongPlayback(data, programId);
  }

  @Get('audio-proxy')
  async proxyAudio(
    @Query('url') url: string,
  ): Promise<StreamableFile> {
    const proxied = await this.programService.proxyAudio(url);
    return new StreamableFile(proxied.buffer, {
      type: proxied.contentType,
      disposition: 'inline'
    });
  }

  @Get('state')
  async getState() {
    return this.programService.getState();
  }

  @Post(':programId/scenes')
  async addSceneToProgram(
    @Param('programId') programId: string,
    @Body() data: { sceneId: number },
  ) {
    return this.programService.addSceneToProgram(data.sceneId, programId);
  }

  @Delete(':programId/scenes/:sceneId')
  async removeSceneFromProgram(
    @Param('programId') programId: string,
    @Param('sceneId') sceneId: string,
  ) {
    return this.programService.removeSceneFromProgram(
      Number(sceneId),
      programId,
    );
  }

  @Post(':programId/activate')
  async activateSceneById(
    @Param('programId') programId: string,
    @Body() data: { sceneId: number; transitionId?: string | null },
  ) {
    return this.programService.activateScene(
      data.sceneId,
      programId,
      data.transitionId,
    );
  }

  @Get(':programId/stage')
  async getStagedSceneById(@Param('programId') programId: string) {
    return this.programService.getStagedScene(programId);
  }

  @Post(':programId/stage')
  async stageSceneById(
    @Param('programId') programId: string,
    @Body() data: { sceneId?: number | null },
  ) {
    const nextSceneId =
      typeof data?.sceneId === 'number' && Number.isFinite(data.sceneId)
        ? data.sceneId
        : null;
    return this.programService.stageScene(nextSceneId, programId);
  }

  @Post(':programId/off-air')
  async takeProgramOffAirById(@Param('programId') programId: string) {
    return this.programService.takeProgramOffAir(programId);
  }

  @Post(':programId/song/off-air')
  async takeProgramSongOffAirById(@Param('programId') programId: string) {
    return this.programService.takeProgramSongOffAir(programId);
  }

  @Put(':programId/audio-bus')
  async updateProgramAudioBusById(
    @Param('programId') programId: string,
    @Body() data: { songSequence?: unknown },
  ) {
    return this.programService.updateProgramAudioBus(data, programId);
  }

  @Post('activate')
  async activateScene(
    @Body() data: { sceneId: number; transitionId?: string | null },
  ) {
    return this.programService.activateScene(
      data.sceneId,
      undefined,
      data.transitionId,
    );
  }

  @Post('off-air')
  async takeProgramOffAir() {
    return this.programService.takeProgramOffAir();
  }

  @Post('song/off-air')
  async takeProgramSongOffAir() {
    return this.programService.takeProgramSongOffAir();
  }

  @Sse(':programId/events')
  eventsById(
    @Param('programId') programId: string,
  ): Observable<{ data: string }> {
    return this.programService.getEventStream(programId);
  }

  @Sse('events')
  events(): Observable<{ data: string }> {
    return this.programService.getEventStream();
  }
}
