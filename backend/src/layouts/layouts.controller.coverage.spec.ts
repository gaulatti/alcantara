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

  const request = { user: { authorization: { teamId: 7 } } };

  it("delegates every route to the service with numeric ids and the caller's team", async () => {
    await expect(controller.findAll(request)).resolves.toEqual(['all']);
    expect(service.findAll).toHaveBeenCalledWith(7);
    await expect(controller.findOne('4', request)).resolves.toBe('one');
    expect(service.findOne).toHaveBeenCalledWith(4, 7);
    const created = { name: 'n', componentType: 'c' };
    await expect(controller.create(created, request)).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith(created, 7);
    await expect(controller.update('5', { name: 'x' }, request)).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith(5, { name: 'x' }, 7);
    await expect(controller.remove('6', request)).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(6, 7);
  });
});
