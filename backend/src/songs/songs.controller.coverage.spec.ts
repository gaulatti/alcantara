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

  const request = { user: { authorization: { teamId: 7 } } };

  beforeEach(() => jest.clearAllMocks());

  it('applies defaults when no query parameters are given', async () => {
    await expect(controller.findAll(request)).resolves.toBe('all');
    expect(service.findAll).toHaveBeenCalledWith(
      {
        search: undefined,
        enabled: undefined,
        sortBy: undefined,
        sortOrder: undefined,
        page: 1,
        limit: 50,
        programId: undefined,
      },
      7,
    );
  });

  it('parses enabled, page and limit from the query', async () => {
    await controller.findAll(
      request,
      'q',
      'true',
      'title',
      'asc',
      '3',
      '10',
      'radio',
    );
    expect(service.findAll).toHaveBeenLastCalledWith(
      {
        search: 'q',
        enabled: true,
        sortBy: 'title',
        sortOrder: 'asc',
        page: 3,
        limit: 10,
        programId: 'radio',
      },
      7,
    );
    await controller.findAll(
      request,
      undefined,
      'false',
      undefined,
      undefined,
      '0',
      '0',
    );
    expect(service.findAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, page: 1, limit: 0 }),
      7,
    );
  });

  it('delegates findOne, create, update and remove with numeric ids', async () => {
    await expect(controller.findOne('2', request, 'radio')).resolves.toBe(
      'one',
    );
    expect(service.findOne).toHaveBeenCalledWith(2, 'radio', 7);
    await expect(controller.create({ title: 't' }, request)).resolves.toBe(
      'created',
    );
    expect(service.create).toHaveBeenCalledWith({ title: 't' }, 7);
    await expect(controller.update('3', { title: 'u' }, request)).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith(3, { title: 'u' }, 7);
    await expect(controller.remove('4', request)).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(4, 7);
  });
});
