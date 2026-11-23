import { StingersController } from './stingers.controller';

describe('StingersController', () => {
  const service = {
    findAll: jest.fn().mockResolvedValue(['all']),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  const controller = new StingersController(service as never);

  it('delegates every route to the service with numeric ids', async () => {
    await expect(controller.listStingers()).resolves.toEqual(['all']);
    const body = { name: 'n', videoUrl: 'u' };
    await expect(controller.createStinger(body)).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith(body);
    await expect(
      controller.updateStinger('8', { enabled: false }),
    ).resolves.toBe('updated');
    expect(service.update).toHaveBeenCalledWith(8, { enabled: false });
    await expect(controller.deleteStinger('9')).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(9);
  });
});
