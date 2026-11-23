import { LayoutsController } from './layouts.controller';

describe('LayoutsController', () => {
  const service = {
    findAll: jest.fn().mockResolvedValue(['all']),
    findOne: jest.fn().mockResolvedValue('one'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  const controller = new LayoutsController(service as never);

  it('delegates every route to the service with numeric ids', async () => {
    await expect(controller.findAll()).resolves.toEqual(['all']);
    await expect(controller.findOne('4')).resolves.toBe('one');
    expect(service.findOne).toHaveBeenCalledWith(4);
    const created = { name: 'n', componentType: 'c' };
    await expect(controller.create(created)).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith(created);
    await expect(controller.update('5', { name: 'x' })).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith(5, { name: 'x' });
    await expect(controller.remove('6')).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(6);
  });
});
