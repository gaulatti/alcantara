import { Controller, Get, Post, Body, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ProgramService } from './program.service';

@Controller('program')
export class ProgramController {
  constructor(private readonly programService: ProgramService) {}

  @Get('state')
  async getState() {
    return this.programService.getState();
  }

  @Post('activate')
  async activateScene(@Body() data: { sceneId: number }) {
    return this.programService.activateScene(data.sceneId);
  }

  @Sse('events')
  events(): Observable<{ data: string }> {
    return this.programService.getEventStream();
  }
}
