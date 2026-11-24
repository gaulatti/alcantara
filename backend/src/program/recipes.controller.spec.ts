import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { RecipesController } from './recipes.controller';

describe('RecipesController (gaulatti/alcantara#424)', () => {
  const recipes = {
    list: jest.fn(async () => ['list']),
    create: jest.fn(async () => 'created'),
    update: jest.fn(async () => 'updated'),
    expand: jest.fn(async () => 'expanded'),
  };
  const controller = new RecipesController(recipes as any);
  const request = { user: { authorization: { teamId: 7 } } };

  it('hands each route to the service, with an empty body when none is sent', async () => {
    expect(await controller.listRecipes('tv')).toEqual(['list']);
    expect(await controller.createRecipe('tv', { name: 'Song' })).toBe(
      'created',
    );
    expect(recipes.create).toHaveBeenCalledWith('tv', { name: 'Song' });
    expect(
      await controller.updateRecipe('tv', 7, undefined as any, request),
    ).toBe('updated');
    expect(recipes.update).toHaveBeenCalledWith('tv', 7, {}, 7);
    expect(
      await controller.expandRecipe('tv', 7, undefined as any, request),
    ).toBe('expanded');
    expect(recipes.expand).toHaveBeenCalledWith('tv', 7, {}, 7);
    await controller.createRecipe('tv', undefined as any);
    expect(recipes.create).toHaveBeenLastCalledWith('tv', {});
    await controller.expandRecipe('tv', 7, { params: { songId: 1 } }, request);
    expect(recipes.expand).toHaveBeenLastCalledWith(
      'tv',
      7,
      { params: { songId: 1 } },
      7,
    );
  });

  it('reads with flight.read and writes with flight.manage', () => {
    const permission = (name: keyof RecipesController) =>
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        RecipesController.prototype[name],
      );
    expect(permission('listRecipes')).toBe(ALCANTARA_PERMISSIONS.flight.read);
    expect(permission('expandRecipe')).toBe(ALCANTARA_PERMISSIONS.flight.read);
    expect(permission('createRecipe')).toBe(
      ALCANTARA_PERMISSIONS.flight.manage,
    );
    expect(permission('updateRecipe')).toBe(
      ALCANTARA_PERMISSIONS.flight.manage,
    );
  });
});
