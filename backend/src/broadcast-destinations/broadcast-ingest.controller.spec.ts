/* eslint-disable @typescript-eslint/unbound-method */
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { BroadcastDestinationsController } from './broadcast-destinations.controller';

describe('ingest credential route', () => {
  const handler = BroadcastDestinationsController.prototype.issueIngest;

  it('needs broadcast.manage, the permission that already covers the catalog references', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler)).toBe(
      ALCANTARA_PERMISSIONS.broadcast.manage,
    );
  });

  it('is never cached', () => {
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });

  it('audits the signed-in subject for the requested destination', async () => {
    const issue = jest.fn().mockResolvedValue({ ok: true });
    const controller = new BroadcastDestinationsController(
      {} as never,
      {
        issue,
      } as never,
      {} as never,
    );
    await controller.issueIngest('youtube', {
      user: { sub: 'user-1', authorization: { teamId: 7 } },
    });
    expect(issue).toHaveBeenCalledWith('youtube', 'user-1', 7);
  });
});
