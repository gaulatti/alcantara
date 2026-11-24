import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { RecipesService, type RecipeInput } from './recipes.service';

type TeamRequest = { user: { authorization: { teamId: number } } };

/** gaulatti/alcantara#424 (#222 R3): a program's rundown recipes (contract C3). */
@Controller('program')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get(':programId/recipes')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async listRecipes(@Param('programId') programId: string) {
    return this.recipes.list(programId);
  }

  @Post(':programId/recipes')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async createRecipe(
    @Param('programId') programId: string,
    @Body() body: RecipeInput,
  ) {
    return this.recipes.create(programId, body ?? {});
  }

  @Put(':programId/recipes/:recipeId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async updateRecipe(
    @Param('programId') programId: string,
    @Param('recipeId', ParseIntPipe) recipeId: number,
    @Body() body: RecipeInput,
    @Req() request: TeamRequest,
  ) {
    return this.recipes.update(
      programId,
      recipeId,
      body ?? {},
      request.user.authorization.teamId,
    );
  }

  /** A preview: the cues of one use and its issues. Nothing is written. */
  @Post(':programId/recipes/:recipeId/expand')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async expandRecipe(
    @Param('programId') programId: string,
    @Param('recipeId', ParseIntPipe) recipeId: number,
    @Body()
    body: { params?: { songId?: unknown; labelId?: unknown }; useId?: unknown },
    @Req() request: TeamRequest,
  ) {
    return this.recipes.expand(
      programId,
      recipeId,
      body ?? {},
      request.user.authorization.teamId,
    );
  }

  /**
   * gaulatti/alcantara#465: deletes a recipe read at `revision`. 409 `on_air` while a use is in a running
   * rundown, 409 `has_uses` while uses remain unless `removeUses=true`, 409 on a stale revision.
   */
  @Delete(':programId/recipes/:recipeId')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.manage)
  async deleteRecipe(
    @Param('programId') programId: string,
    @Param('recipeId', ParseIntPipe) recipeId: number,
    @Query('revision', ParseIntPipe) revision: number,
    @Query('removeUses', new ParseBoolPipe({ optional: true }))
    removeUses?: boolean,
  ) {
    return this.recipes.delete(programId, recipeId, {
      revision,
      removeUses: removeUses === true,
    });
  }
}
