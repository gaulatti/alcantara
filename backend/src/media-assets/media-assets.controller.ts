import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { Public } from '../auth/public.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  MediaAssetsService,
  type MediaAssetAuthorization,
} from './media-assets.service';

type AuthorizedRequest = {
  user: { authorization: MediaAssetAuthorization };
};

@Controller()
@RequirePermission(ALCANTARA_PERMISSIONS.access)
export class MediaAssetsController {
  constructor(private readonly mediaAssets: MediaAssetsService) {}

  @Get('media-assets')
  findAll(
    @Req() request: AuthorizedRequest,
    @Query('search') search?: string,
    @Query('mediaType') mediaType?: string,
    @Query('capability') capability?: string,
    @Query('labelId') labelId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mediaAssets.findAll(
      {
        search,
        mediaType,
        capability,
        labelId,
        page: page ? Math.max(1, Number(page)) : 1,
        limit: limit ? Math.min(200, Math.max(1, Number(limit))) : 50,
      },
      request.user.authorization,
    );
  }

  @Get('media-assets/:id')
  findOne(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.mediaAssets.findOne(id, request.user.authorization);
  }

  @Post('media-assets/background-audio')
  createBackgroundAudio(
    @Body()
    body: { name?: unknown; sourceUrl?: unknown; defaultVolume?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.createBackgroundAudio(
      body,
      request.user.authorization,
    );
  }

  @Delete('media-assets/:id')
  removeStandaloneAsset(
    @Param('id') id: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.removeStandaloneAsset(
      id,
      request.user.authorization,
    );
  }

  @Put('media-assets/:id/labels')
  replaceAssetLabels(
    @Param('id') id: string,
    @Body() body: { labelIds?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.replaceAssetLabels(
      id,
      body.labelIds,
      request.user.authorization,
    );
  }

  @Get('media-labels')
  findLabels(
    @Req() request: AuthorizedRequest,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mediaAssets.findLabels(
      {
        search,
        page: page ? Math.max(1, Number(page)) : 1,
        limit: limit ? Math.min(200, Math.max(1, Number(limit))) : 50,
      },
      request.user.authorization,
    );
  }

  @Get('media-labels/:id/images')
  @Public()
  resolveLabelImages(@Param('id') id: string) {
    return this.mediaAssets.resolveLabelImages(id);
  }

  @Get('media-labels/:id')
  findLabel(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.mediaAssets.findLabel(id, request.user.authorization);
  }

  @Post('media-labels')
  createLabel(
    @Body() body: { name?: unknown; description?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.createLabel(body, request.user.authorization);
  }

  @Put('media-labels/:id')
  updateLabel(
    @Param('id') id: string,
    @Body() body: { name?: unknown; description?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.updateLabel(id, body, request.user.authorization);
  }

  @Put('media-labels/:id/assets')
  replaceLabelAssets(
    @Param('id') id: string,
    @Body() body: { assetIds?: unknown },
    @Req() request: AuthorizedRequest,
  ) {
    return this.mediaAssets.replaceLabelAssets(
      id,
      body.assetIds,
      request.user.authorization,
    );
  }

  @Delete('media-labels/:id')
  removeLabel(@Param('id') id: string, @Req() request: AuthorizedRequest) {
    return this.mediaAssets.removeLabel(id, request.user.authorization);
  }
}
