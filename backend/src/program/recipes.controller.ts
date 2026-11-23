import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { RequirePermission } from '../auth/require-permission.decorator';
import { RecipesService, type RecipeInput } from './recipes.service';

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
  ) {
    return this.recipes.update(programId, recipeId, body ?? {});
  }

  /** A preview: the cues of one use and its issues. Nothing is written. */
  @Post(':programId/recipes/:recipeId/expand')
  @RequirePermission(ALCANTARA_PERMISSIONS.flight.read)
  async expandRecipe(
    @Param('programId') programId: string,
    @Param('recipeId', ParseIntPipe) recipeId: number,
    @Body()
    body: { params?: { songId?: unknown; labelId?: unknown }; useId?: unknown },
  ) {
    return this.recipes.expand(programId, recipeId, body ?? {});
  }
}
