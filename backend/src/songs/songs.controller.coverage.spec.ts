import { SongsController } from './songs.controller';

describe('SongsController', () => {
  const service = {
    findAll: jest.fn().mockResolvedValue('all'),
    findOne: jest.fn().mockResolvedValue('one'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  const controller = new SongsController(service as never);

  beforeEach(() => jest.clearAllMocks());

  it('applies defaults when no query parameters are given', async () => {
    await expect(controller.findAll()).resolves.toBe('all');
    expect(service.findAll).toHaveBeenCalledWith({
      search: undefined,
      enabled: undefined,
      sortBy: undefined,
      sortOrder: undefined,
      page: 1,
      limit: 50,
      programId: undefined,
    });
  });

  it('parses enabled, page and limit from the query', async () => {
    await controller.findAll('q', 'true', 'title', 'asc', '3', '10', 'radio');
    expect(service.findAll).toHaveBeenLastCalledWith({
      search: 'q',
      enabled: true,
      sortBy: 'title',
      sortOrder: 'asc',
      page: 3,
      limit: 10,
      programId: 'radio',
    });
    await controller.findAll(
      undefined,
      'false',
      undefined,
      undefined,
      '0',
      '0',
    );
    expect(service.findAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, page: 1, limit: 0 }),
    );
  });

  it('delegates findOne, create, update and remove with numeric ids', async () => {
    await expect(controller.findOne('2', 'radio')).resolves.toBe('one');
    expect(service.findOne).toHaveBeenCalledWith(2, 'radio');
    await expect(controller.create({ title: 't' })).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith({ title: 't' });
    await expect(controller.update('3', { title: 'u' })).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith(3, { title: 'u' });
    await expect(controller.remove('4')).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(4);
  });
});
