import {
  Controller,
  Get,
  Post,
  Body,
  Sse,
  Param,
  Delete,
  Put,
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
      mainMasterVolume?: number;
      songMasterVolume?: number;
      instantMasterVolume?: number;
      songMuted?: boolean;
      instantMuted?: boolean;
      songSolo?: boolean;
      instantSolo?: boolean;
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
      song?: number;
      instants?: number;
      main?: number;
    },
  ) {
    return this.programService.updateProgramAudioMeter(data, programId);
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
