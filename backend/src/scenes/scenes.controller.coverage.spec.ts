/* eslint-disable @typescript-eslint/unbound-method -- Jest mocks are intentionally loosely typed. */
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { ScenesController } from './scenes.controller';

describe('ScenesController', () => {
  const service = {
    findAll: jest.fn().mockResolvedValue('all'),
    findOne: jest.fn().mockResolvedValue('one'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    updateChyron: jest.fn().mockResolvedValue('chyron'),
    drawModoItalianoBracket: jest.fn().mockResolvedValue('draw'),
    voteModoItalianoBracket: jest.fn().mockResolvedValue('vote'),
    openModoItalianoBracketVoting: jest.fn().mockResolvedValue('open'),
    remove: jest.fn().mockResolvedValue('removed'),
  };
  const controller = new ScenesController(service as never);

  it('delegates CRUD routes with numeric ids', async () => {
    await expect(controller.findAll()).resolves.toBe('all');
    await expect(controller.findOne('3')).resolves.toBe('one');
    expect(service.findOne).toHaveBeenCalledWith(3);
    const body = { name: 'n', layoutId: 1 };
    await expect(controller.create(body)).resolves.toBe('created');
    expect(service.create).toHaveBeenCalledWith(body);
    await expect(controller.update('4', { name: 'x' })).resolves.toBe(
      'updated',
    );
    expect(service.update).toHaveBeenCalledWith(4, { name: 'x' });
    await expect(controller.remove('5')).resolves.toBe('removed');
    expect(service.remove).toHaveBeenCalledWith(5);
  });

  it('delegates chyron and bracket operations', async () => {
    await expect(
      controller.updateChyron('6', { chyronText: 'hi' }),
    ).resolves.toBe('chyron');
    expect(service.updateChyron).toHaveBeenCalledWith(6, 'hi');
    await expect(
      controller.drawModoItalianoBracket('7', { seed: 1 }),
    ).resolves.toBe('draw');
    expect(service.drawModoItalianoBracket).toHaveBeenCalledWith(7, {
      seed: 1,
    });
    const vote = { matchId: 1, voterId: 'v', songId: null };
    await expect(controller.voteModoItalianoBracket('8', vote)).resolves.toBe(
      'vote',
    );
    expect(service.voteModoItalianoBracket).toHaveBeenCalledWith(8, vote);
    await expect(
      controller.openModoItalianoBracketVoting('9', { matchId: 2 }),
    ).resolves.toBe('open');
    expect(service.openModoItalianoBracketVoting).toHaveBeenCalledWith(9, {
      matchId: 2,
    });
  });

  it('requires read at class level and stricter permissions on mutations', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, ScenesController)).toBe(
      ALCANTARA_PERMISSIONS.scene.read,
    );
    const proto = ScenesController.prototype;
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto.create)).toBe(
      ALCANTARA_PERMISSIONS.scene.manage,
    );
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto.updateChyron),
    ).toBe(ALCANTARA_PERMISSIONS.scene.operate);
  });
});
