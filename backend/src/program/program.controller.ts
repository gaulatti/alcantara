import { Controller, Get, Post, Body, Sse, Param, Delete, Put } from '@nestjs/common';
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

  @Get('broadcast-settings')
  async getBroadcastSettings() {
    return this.programService.getBroadcastSettings();
  }

  @Put('broadcast-settings')
  async updateBroadcastSettings(
    @Body() data: { enabled: boolean; startTime?: string | null },
  ) {
    return this.programService.updateBroadcastSettings(data);
  }

  @Get(':programId/state')
  async getStateById(@Param('programId') programId: string) {
    return this.programService.getState(programId);
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
    return this.programService.removeSceneFromProgram(Number(sceneId), programId);
  }

  @Post(':programId/activate')
  async activateSceneById(
    @Param('programId') programId: string,
    @Body() data: { sceneId: number; transitionId?: string | null },
  ) {
    return this.programService.activateScene(data.sceneId, programId, data.transitionId);
  }

  @Post('activate')
  async activateScene(@Body() data: { sceneId: number; transitionId?: string | null }) {
    return this.programService.activateScene(data.sceneId, undefined, data.transitionId);
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
