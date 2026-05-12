import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { StingersService } from './stingers.service';

@Controller('stingers')
export class StingersController {
  constructor(private readonly stingersService: StingersService) {}

  @Get()
  async listStingers() {
    return this.stingersService.findAll();
  }

  @Post()
  async createStinger(
    @Body() data: { name: string; videoUrl: string; cutPointMs?: number; enabled?: boolean },
  ) {
    return this.stingersService.create(data);
  }

  @Put(':stingerId')
  async updateStinger(
    @Param('stingerId') stingerId: string,
    @Body() data: { name?: string; videoUrl?: string; cutPointMs?: number; enabled?: boolean },
  ) {
    return this.stingersService.update(Number(stingerId), data);
  }

  @Delete(':stingerId')
  async deleteStinger(@Param('stingerId') stingerId: string) {
    return this.stingersService.remove(Number(stingerId));
  }
}
