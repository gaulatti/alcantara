import { StingersController } from './stingers.controller';

describe('StingersController', () => {
  const service = {
    findAll: jest.fn().mockResolvedValue(['all']),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  const controller = new StingersController(service as never);

  const request = { user: { authorization: { teamId: 7 } } };

  it('delegates every route to the service with numeric ids', async () => {
    await expect(controller.listStingers(request)).resolves.toEqual(['all']);
    const body = { name: 'n', videoUrl: 'u' };
    await expect(controller.createStinger(body, request)).resolves.toBe(
      'created',
    );
    expect(service.findAll).toHaveBeenCalledWith(7);
    expect(service.create).toHaveBeenCalledWith(body, 7);
    await expect(
      controller.updateStinger('8', { enabled: false }, request),
    ).resolves.toBe('updated');
    expect(service.update).toHaveBeenCalledWith(8, { enabled: false }, 7);
    await expect(controller.deleteStinger('9', request)).resolves.toBe(
      'removed',
    );
    expect(service.remove).toHaveBeenCalledWith(9, 7);
  });
});
