import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RealtimeTicketService } from '../auth/realtime-ticket.service';
import { FlightMcpTools } from '../mcp/capabilities/flight';
import { ProgramMcpTools } from '../mcp/capabilities/program';
import { PompeiiService } from '../auth/pompeii.service';
import { SongLeavesMcpTools } from '../mcp/capabilities/song-leaves';
import { PrismaService } from '../prisma.service';
import { RadioClocksController } from './radio-clocks.controller';
import { RadioClocksService } from './radio-clocks.service';
import { RadioDaypartPlanner } from './radio-daypart-planner.service';
import { RadioDaypartsController } from './radio-dayparts.controller';
import { RadioDaypartsService } from './radio-dayparts.service';
import { FlightService } from './flight.service';
import { ProgramController } from './program.controller';
import { ProgramModule } from './program.module';
import { ProgramRealtimeService } from './program.realtime.service';
import { ProgramTeamAccess } from '../tenancy/program-team-access';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProgramTeamInterceptor } from '../tenancy/program-team.interceptor';
import { ProgramService } from './program.service';
import { SceneAssetScope } from './scene-asset-scope';
import { ProgramTemplateService } from './program-template.service';
import { ManagedMetricsService } from '../observability/managed-metrics.service';
import { RecipeMcpTools } from '../mcp/capabilities/recipes';
import { DaypartMcpTools } from '../mcp/capabilities/dayparts';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { RadioService } from '../radio/radio.service';
import { ARTIST_LABEL_LOOKUP } from './artist-label-lookup';
import { OperatorChangeModule } from '../operator-change/operator-change.module';
import { ArtistLabelsModule } from '../artist-labels/artist-labels.module';
import { ArtistLabelsService } from '../artist-labels/artist-labels.service';
import { RendererKeysModule } from '../renderer-keys/renderer-keys.module';

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

// The deployment team the program MCP tools read (gaulatti/alcantara#337), as the auth module provides it.
@Global()
@Module({
  providers: [{ provide: PompeiiService, useValue: { teamId: 7 } }],
  exports: [PompeiiService],
})
class PompeiiStubModule {}

@Global()
@Module({
  providers: [{ provide: ManagedMetricsService, useValue: {} }],
  exports: [ManagedMetricsService],
})
class MetricsStubModule {}

// The radio service is global in the application; the flight MCP tools judge playout on it.
@Global()
@Module({
  providers: [{ provide: RadioService, useValue: {} }],
  exports: [RadioService],
})
class RadioStubModule {}

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
      // The metrics service is global in the application; RecipesService counts its work there.
      imports: [
        TicketsModule,
        MetricsStubModule,
        RadioStubModule,
        ProgramModule,
        ConsumerModule,
        PompeiiStubModule,
      ],
    })
      .overrideProvider(ProgramService)
      .useValue(fakeProgramService)
      .overrideProvider(FlightService)
      .useValue(fakeFlightService)
      .overrideProvider(RadioDaypartPlanner)
      .useValue({})
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
      ProgramTeamAccess,
    ]);
    expect(Reflect.getMetadata('controllers', ProgramModule)).toEqual([
      ProgramController,
      RecipesController,
      RadioClocksController,
      RadioDaypartsController,
    ]);
    expect(Reflect.getMetadata('providers', ProgramModule)).toEqual([
      ProgramService,
      SceneAssetScope,
      ProgramRealtimeService,
      FlightService,
      ProgramTemplateService,
      ProgramMcpTools,
      SongLeavesMcpTools,
      FlightMcpTools,
      RecipesService,
      RecipeMcpTools,
      RadioClocksService,
      RadioDaypartsService,
      RadioDaypartPlanner,
      DaypartMcpTools,
      ProgramTeamAccess,
      { provide: APP_INTERCEPTOR, useClass: ProgramTeamInterceptor },
      {
        provide: ARTIST_LABEL_LOOKUP,
        useFactory: expect.any(Function),
        inject: [ArtistLabelsService],
      },
      PrismaService,
    ]);
    expect(Reflect.getMetadata('imports', ProgramModule)).toEqual([
      ArtistLabelsModule,
      OperatorChangeModule,
      RendererKeysModule,
    ]);
  });
});
