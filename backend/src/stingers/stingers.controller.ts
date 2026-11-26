import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { StingersService } from './stingers.service';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';

type TeamRequest = { user: { authorization: { teamId: number } } };

@Controller('stingers')
@RequirePermission(ALCANTARA_PERMISSIONS.stinger.read)
export class StingersController {
  constructor(private readonly stingersService: StingersService) {}

  @Get()
  async listStingers(@Req() request: TeamRequest) {
    return this.stingersService.findAll(request.user.authorization.teamId);
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
    @Req() request: TeamRequest,
  ) {
    return this.stingersService.create(data, request.user.authorization.teamId);
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
    @Req() request: TeamRequest,
  ) {
    return this.stingersService.update(
      Number(stingerId),
      data,
      request.user.authorization.teamId,
    );
  }

  @Delete(':stingerId')
  @RequirePermission(ALCANTARA_PERMISSIONS.stinger.manage)
  async deleteStinger(
    @Param('stingerId') stingerId: string,
    @Req() request: TeamRequest,
  ) {
    return this.stingersService.remove(
      Number(stingerId),
      request.user.authorization.teamId,
    );
  }
}
