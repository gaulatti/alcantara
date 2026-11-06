import { Test } from '@nestjs/testing';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import { FlightService } from '../program/flight.service';
import { ProgramTemplateService } from '../program/program-template.service';
import { ProgramRealtimeService } from '../program/program.realtime.service';
import { ProgramService } from '../program/program.service';
import { PrismaService } from '../prisma.service';
import { InstantsController } from './instants.controller';
import { InstantsModule } from './instants.module';

function build() {
  const program = {
    listInstants: jest.fn().mockResolvedValue(['list']),
    createInstant: jest.fn().mockResolvedValue('created'),
    updateInstant: jest.fn().mockResolvedValue('updated'),
    deleteInstant: jest.fn().mockResolvedValue('deleted'),
    playInstant: jest.fn().mockResolvedValue('played'),
    stopAllInstants: jest.fn().mockResolvedValue('stopped'),
  };
  return { controller: new InstantsController(program as never), program };
}

describe('InstantsController (coverage)', () => {
  it('lists instants for an optional program', async () => {
    const { controller, program } = build();
    await expect(controller.listInstants('p1')).resolves.toEqual(['list']);
    await controller.listInstants();
    expect(program.listInstants.mock.calls).toEqual([['p1'], [undefined]]);
  });

  it('creates an instant', async () => {
    const { controller, program } = build();
    const data = { name: 'n', audioUrl: 'u', volume: 0.5, enabled: true };
    await expect(controller.createInstant(data)).resolves.toBe('created');
    expect(program.createInstant).toHaveBeenCalledWith(data);
  });

  it('updates an instant converting the id to a number', async () => {
    const { controller, program } = build();
    await expect(controller.updateInstant('7', { name: 'x' })).resolves.toBe(
      'updated',
    );
    expect(program.updateInstant).toHaveBeenCalledWith(7, { name: 'x' });
  });

  it('deletes an instant converting the id to a number', async () => {
    const { controller, program } = build();
    await expect(controller.deleteInstant('7')).resolves.toBe('deleted');
    expect(program.deleteInstant).toHaveBeenCalledWith(7);
  });

  it('plays an instant preferring the query program id over the body', async () => {
    const { controller, program } = build();
    await controller.playInstant('3', 'q', { programId: 'b' });
    await controller.playInstant('3', undefined, { programId: 'b' });
    await controller.playInstant('3');
    await controller.playInstant('3', undefined, {});
    expect(program.playInstant.mock.calls).toEqual([
      [3, 'q'],
      [3, 'b'],
      [3, undefined],
      [3, undefined],
    ]);
  });

  it('stops all instants preferring the query program id over the body', async () => {
    const { controller, program } = build();
    await controller.stopAllInstants('q', { programId: 'b' });
    await controller.stopAllInstants(undefined, { programId: 'b' });
    await controller.stopAllInstants();
    expect(program.stopAllInstants.mock.calls).toEqual([
      ['q'],
      ['b'],
      [undefined],
    ]);
  });

  it('declares the permissions required by each route', () => {
    const proto = InstantsController.prototype;
    const perm = (target: object) =>
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, target);
    expect(perm(InstantsController)).toBe(ALCANTARA_PERMISSIONS.instant.read);
    expect(perm(proto.createInstant)).toBe(
      ALCANTARA_PERMISSIONS.instant.manage,
    );
    expect(perm(proto.playInstant)).toBe(ALCANTARA_PERMISSIONS.instant.operate);
    expect(perm(proto.stopAllInstants)).toBe(
      ALCANTARA_PERMISSIONS.instant.operate,
    );
  });

  it('records Object as the paramtype when ProgramService is unresolved', () => {
    jest.isolateModules(() => {
      jest.doMock('../program/program.service', () => ({}));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./instants.controller');
      expect(
        Reflect.getMetadata('design:paramtypes', mod.InstantsController),
      ).toEqual([Object]);
    });
    jest.dontMock('../program/program.service');
  });
});

describe('InstantsModule (coverage)', () => {
  it('wires the controller to the program service exported by ProgramModule', async () => {
    const program = { listInstants: jest.fn().mockResolvedValue(['x']) };
    const moduleRef = await Test.createTestingModule({
      imports: [InstantsModule],
    })
      .overrideProvider(ProgramService)
      .useValue(program)
      .overrideProvider(ProgramRealtimeService)
      .useValue({})
      .overrideProvider(FlightService)
      .useValue({})
      .overrideProvider(ProgramTemplateService)
      .useValue({})
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    const controller = moduleRef.get(InstantsController);
    await expect(controller.listInstants('p')).resolves.toEqual(['x']);
    expect(program.listInstants).toHaveBeenCalledWith('p');
    await moduleRef.close();
  });
});
