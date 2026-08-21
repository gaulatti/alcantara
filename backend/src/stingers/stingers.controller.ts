import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { StingersService } from './stingers.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('stingers')
@RequirePermission(ALCANTARA_PERMISSIONS.stinger.read)
export class StingersController {
  constructor(private readonly stingersService: StingersService) {}

  @Get()
  async listStingers() {
    return this.stingersService.findAll();
  }

  @Post()
  @RequirePermission(ALCANTARA_PERMISSIONS.stinger.manage)
  async createStinger(
    @Body()
    data: {
      name: string;
      videoUrl: string;
      cutPointMs?: number;
      enabled?: boolean;
    },
  ) {
    return this.stingersService.create(data);
  }

  @Put(':stingerId')
  @RequirePermission(ALCANTARA_PERMISSIONS.stinger.manage)
  async updateStinger(
    @Param('stingerId') stingerId: string,
    @Body()
    data: {
      name?: string;
      videoUrl?: string;
      cutPointMs?: number;
      enabled?: boolean;
    },
  ) {
    return this.stingersService.update(Number(stingerId), data);
  }

  @Delete(':stingerId')
  @RequirePermission(ALCANTARA_PERMISSIONS.stinger.manage)
  async deleteStinger(@Param('stingerId') stingerId: string) {
    return this.stingersService.remove(Number(stingerId));
  }
}
