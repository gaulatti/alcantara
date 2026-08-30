/* eslint-disable @typescript-eslint/unbound-method */
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';

describe('BroadcastDestinationsController permissions', () => {
  it('keeps view, operation, and catalog management independently enforced', () => {
    const prototype = BroadcastDestinationsController.prototype;
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype.getProgramState),
    ).toBe(ALCANTARA_PERMISSIONS.broadcast.view);
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype.start)).toBe(
      ALCANTARA_PERMISSIONS.broadcast.operate,
    );
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype.createDestination),
    ).toBe(ALCANTARA_PERMISSIONS.broadcast.manage);
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, prototype.listCatalog),
    ).toBe(ALCANTARA_PERMISSIONS.broadcast.manage);
  });
});
