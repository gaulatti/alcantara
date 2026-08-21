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
import { FlightService } from './flight.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('program')
@RequirePermission(ALCANTARA_PERMISSIONS.program.read)
export class ProgramController {
  constructor(
    private readonly programService: ProgramService,
    private readonly flightService: FlightService,
  ) {}

  @Get()
  async listPrograms() {
    return this.programService.listPrograms();
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async createProgram(@Body() data: { programId: string; type?: string }) {
    return this.programService.createProgram(data.programId, data.type);
  }

  @Put(':programId')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async renameProgram(
    @Param('programId') programId: string,
    @Body() data: { nextProgramId: string; type?: string },
  ) {
    return this.programService.renameProgram(
      programId,
      data.nextProgramId,
      data.type,
    );
  }

  @Delete(':programId')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async deleteProgram(@Param('programId') programId: string) {
    return this.programService.deleteProgram(programId);
  }

  @Get('broadcast-settings')
  @Public()
  async getBroadcastSettings() {
    // The service currently exposes a legacy loosely typed settings payload.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.programService.getBroadcastSettings();
  }

  @Put('broadcast-settings')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
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
    // The service currently exposes a legacy loosely typed settings payload.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.programService.updateBroadcastSettings(data);
  }

  @Get(':programId/state')
  @Public()
  async getStateById(@Param('programId') programId: string) {
    return this.programService.getState(programId);
  }

  @Get(':programId/audio-bus')
  @Public()
  async getProgramAudioBusById(@Param('programId') programId: string) {
    return this.programService.getProgramAudioBus(programId);
  }

  @Get(':programId/audio-meter')
  @Public()
  async getProgramAudioMeterById(@Param('programId') programId: string) {
    return this.programService.getProgramAudioMeter(programId);
  }

  @Post(':programId/audio-meter')
  @Public()
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
  @Public()
  async getProgramSceneInstantById(@Param('programId') programId: string) {
    return this.programService.getProgramSceneInstantPlayback(programId);
  }

  @Post(':programId/scene-instant/take')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async takeProgramSceneInstantById(
    @Param('programId') programId: string,
    @Body() data?: { sceneId?: number | null; instantId?: number | null },
  ) {
    const sceneId =
      typeof data?.sceneId === 'number' && Number.isFinite(data.sceneId)
        ? data.sceneId
        : null;
    const instantId =
      typeof data?.instantId === 'number' && Number.isFinite(data.instantId)
        ? data.instantId
        : null;
    return this.programService.takeProgramSceneInstant(
      sceneId,
      programId,
      instantId,
    );
  }

  @Post(':programId/scene-instant/stop')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async stopProgramSceneInstantById(@Param('programId') programId: string) {
    return this.programService.stopProgramSceneInstant(programId);
  }

  @Get(':programId/song-playback')
  @Public()
  async getProgramSongPlaybackById(@Param('programId') programId: string) {
    return this.programService.getProgramSongPlayback(programId);
  }

  @Post(':programId/song-playback')
  @Public()
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
  @Public()
  async proxyAudio(@Query('url') url: string): Promise<StreamableFile> {
    const proxied = await this.programService.proxyAudio(url);
    return new StreamableFile(proxied.buffer, {
      type: proxied.contentType,
      disposition: 'inline',
    });
  }

  @Get('state')
  @Public()
  async getState() {
    return this.programService.getState();
  }

  @Post(':programId/scenes')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async addSceneToProgram(
    @Param('programId') programId: string,
    @Body() data: { sceneId: number },
  ) {
    return this.programService.addSceneToProgram(data.sceneId, programId);
  }

  @Delete(':programId/scenes/:sceneId')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async removeSceneFromProgram(
    @Param('programId') programId: string,
    @Param('sceneId') sceneId: string,
  ) {
    return this.programService.removeSceneFromProgram(
      Number(sceneId),
      programId,
    );
  }

  @Get(':programId/media-groups')
  @Public()
  async listProgramMediaGroups(@Param('programId') programId: string) {
    return this.programService.listProgramMediaGroups(programId);
  }

  @Post(':programId/media-groups')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async addMediaGroupToProgram(
    @Param('programId') programId: string,
    @Body() data: { mediaGroupId: number },
  ) {
    return this.programService.addMediaGroupToProgram(
      data.mediaGroupId,
      programId,
    );
  }

  @Delete(':programId/media-groups/:mediaGroupId')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async removeMediaGroupFromProgram(
    @Param('programId') programId: string,
    @Param('mediaGroupId') mediaGroupId: string,
  ) {
    return this.programService.removeMediaGroupFromProgram(
      Number(mediaGroupId),
      programId,
    );
  }

  @Get(':programId/stingers')
  @Public()
  async listProgramStingers(@Param('programId') programId: string) {
    return this.programService.listProgramStingers(programId);
  }

  @Post(':programId/stingers')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async addStingerToProgram(
    @Param('programId') programId: string,
    @Body() data: { stingerId: number },
  ) {
    return this.programService.addStingerToProgram(data.stingerId, programId);
  }

  @Delete(':programId/stingers/:stingerId')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.manage)
  async removeStingerFromProgram(
    @Param('programId') programId: string,
    @Param('stingerId') stingerId: string,
  ) {
    return this.programService.removeStingerFromProgram(
      Number(stingerId),
      programId,
    );
  }

  @Post(':programId/activate')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
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
  @RequirePermission(ALCANTARA_PERMISSIONS.program.read)
  async getStagedSceneById(@Param('programId') programId: string) {
    return this.programService.getStagedScene(programId);
  }

  @Post(':programId/stage')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
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
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async takeProgramOffAirById(@Param('programId') programId: string) {
    return this.programService.takeProgramOffAir(programId);
  }

  @Post(':programId/song/off-air')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async takeProgramSongOffAirById(@Param('programId') programId: string) {
    return this.programService.takeProgramSongOffAir(programId);
  }

  @Post(':programId/reload')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async reloadProgramById(@Param('programId') programId: string) {
    return this.programService.requestProgramReload(programId);
  }

  @Put(':programId/audio-bus')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async updateProgramAudioBusById(
    @Param('programId') programId: string,
    @Body() data: { songSequence?: unknown; mixerSettings?: unknown },
  ) {
    return this.programService.updateProgramAudioBus(data, programId);
  }

  @Post('activate')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
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
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async takeProgramOffAir() {
    return this.programService.takeProgramOffAir();
  }

  @Post('song/off-air')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async takeProgramSongOffAir() {
    return this.programService.takeProgramSongOffAir();
  }

  @Post('reload')
  @RequirePermission(ALCANTARA_PERMISSIONS.program.operate)
  async reloadProgram() {
    return this.programService.requestProgramReload();
  }

  @Get(':programId/flight')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async listFlightSequencesById(@Param('programId') programId: string) {
    return this.flightService.listFlightSequences(programId);
  }

  @Post(':programId/flight')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async createFlightSequenceById(
    @Param('programId') programId: string,
    @Body() data: { name: string; items?: unknown; loop?: boolean },
  ) {
    return this.flightService.createFlightSequence(programId, data);
  }

  @Put(':programId/flight/:sequenceId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async updateFlightSequenceById(
    @Param('programId') programId: string,
    @Param('sequenceId') sequenceId: string,
    @Body() data: { name?: string; items?: unknown; loop?: boolean },
  ) {
    return this.flightService.updateFlightSequence(
      programId,
      Number(sequenceId),
      data,
    );
  }

  @Delete(':programId/flight/:sequenceId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async deleteFlightSequenceById(
    @Param('programId') programId: string,
    @Param('sequenceId') sequenceId: string,
  ) {
    return this.flightService.deleteFlightSequence(
      programId,
      Number(sequenceId),
    );
  }

  @Post(':programId/flight/:sequenceId/activate')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async activateFlightSequenceById(
    @Param('programId') programId: string,
    @Param('sequenceId') sequenceId: string,
  ) {
    return this.flightService.activateFlightSequence(
      programId,
      Number(sequenceId),
    );
  }

  @Post(':programId/flight/deactivate')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async deactivateFlightSequenceById(@Param('programId') programId: string) {
    return this.flightService.deactivateFlightSequence(programId);
  }

  @Post(':programId/flight/start')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async startFlightById(@Param('programId') programId: string) {
    return this.flightService.start(programId);
  }

  @Post(':programId/flight/stop')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async stopFlightById(@Param('programId') programId: string) {
    return this.flightService.stop(programId);
  }

  @Post(':programId/flight/go')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async goFlightById(@Param('programId') programId: string) {
    return this.flightService.go(programId);
  }

  @Post(':programId/flight/reset')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.operate)
  async resetFlightById(@Param('programId') programId: string) {
    return this.flightService.reset(programId);
  }

  @Sse(':programId/events')
  @Public()
  eventsById(
    @Param('programId') programId: string,
  ): Observable<{ data: string }> {
    return this.programService.getEventStream(programId);
  }

  @Sse('events')
  @Public()
  events(): Observable<{ data: string }> {
    return this.programService.getEventStream();
  }
}
