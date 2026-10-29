import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';
import { PrismaService } from '../prisma.service';
import { FlightService } from './flight.service';
import { ProgramController } from './program.controller';
import { ProgramModule } from './program.module';
import { ProgramRealtimeService } from './program.realtime.service';
import { ProgramService } from './program.service';
import { ProgramTemplateService } from './program-template.service';

@Global()
@Module({
  providers: [RealtimeTicketService],
  exports: [RealtimeTicketService],
})
class TicketsModule {}

@Injectable()
class ProgramConsumer {
  constructor(
    readonly programService: ProgramService,
    readonly realtime: ProgramRealtimeService,
    readonly flight: FlightService,
  ) {}
}

@Module({ providers: [ProgramConsumer] })
class ConsumerModule {}

describe('ProgramModule wiring', () => {
  const removeListener = jest.fn();
  const fakeProgramService = {
    addEventListener: jest.fn().mockReturnValue(removeListener),
  };
  const fakeFlightService = { handleSongEnded: jest.fn() };
  const fakePrisma = {};

  beforeEach(() => {
    removeListener.mockClear();
    fakeProgramService.addEventListener.mockClear();
  });

  async function compile() {
    return Test.createTestingModule({
      imports: [TicketsModule, ProgramModule, ConsumerModule],
    })
      .overrideProvider(ProgramService)
      .useValue(fakeProgramService)
      .overrideProvider(FlightService)
      .useValue(fakeFlightService)
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .compile();
  }

  it('registers the program controller with its resolved collaborators', async () => {
    const moduleRef = await compile();
    const controller = moduleRef.get(ProgramController);
    expect(controller).toBeInstanceOf(ProgramController);
    const internals = controller as unknown as {
      programService: unknown;
      flightService: unknown;
      programTemplateService: unknown;
    };
    expect(internals.programService).toBe(fakeProgramService);
    expect(internals.flightService).toBe(fakeFlightService);
    expect(internals.programTemplateService).toBe(
      moduleRef.get(ProgramTemplateService),
    );
    expect(internals.programTemplateService).toBeInstanceOf(
      ProgramTemplateService,
    );
    expect(Reflect.getMetadata('path', ProgramController)).toBe('program');
    await moduleRef.close();
  });

  it('builds the realtime service from the program, flight and ticket providers', async () => {
    const moduleRef = await compile();
    const realtime = moduleRef.get(ProgramRealtimeService);
    expect(realtime).toBeInstanceOf(ProgramRealtimeService);
    expect(fakeProgramService.addEventListener).toHaveBeenCalledWith(
      expect.any(Function),
    );
    const internals = realtime as unknown as {
      programService: unknown;
      flightService: unknown;
      realtimeTickets: unknown;
    };
    expect(internals.programService).toBe(fakeProgramService);
    expect(internals.flightService).toBe(fakeFlightService);
    expect(internals.realtimeTickets).toBe(
      moduleRef.get(RealtimeTicketService),
    );
    await moduleRef.close();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('exports its services globally to modules that do not import it', async () => {
    const moduleRef = await compile();
    const consumer = moduleRef.get(ProgramConsumer);
    expect(consumer.programService).toBe(fakeProgramService);
    expect(consumer.flight).toBe(fakeFlightService);
    expect(consumer.realtime).toBe(moduleRef.get(ProgramRealtimeService));
    await moduleRef.close();
  });

  it('is declared global and exports only the shared program services', () => {
    expect(Reflect.getMetadata('__module:global__', ProgramModule)).toBe(true);
    expect(Reflect.getMetadata('exports', ProgramModule)).toEqual([
      ProgramService,
      ProgramRealtimeService,
      FlightService,
    ]);
    expect(Reflect.getMetadata('controllers', ProgramModule)).toEqual([
      ProgramController,
    ]);
    expect(Reflect.getMetadata('providers', ProgramModule)).toEqual([
      ProgramService,
      ProgramRealtimeService,
      FlightService,
      ProgramTemplateService,
      PrismaService,
    ]);
  });
});
