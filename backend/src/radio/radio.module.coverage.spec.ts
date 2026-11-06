import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FlightService } from '../program/flight.service';
import { RadioModule } from './radio.module';
import { RadioController } from './radio.controller';
import { RadioMonitorController } from './radio-monitor.controller';
import { RadioMonitorService } from './radio-monitor.service';
import { RadioService } from './radio.service';
import { SongExecutionEngine } from './song-execution.engine';
import { NowPlayingPublisherService } from './now-playing-publisher.service';
import { PalazzoRadioTelemetryService } from './palazzo-telemetry.service';
import { RadioMetricsService } from './radio-metrics.service';
import { RadioOutputConfidenceService } from './radio-output-confidence.service';
import { PalazzoMachineClient } from './palazzo-machine.client';
import { PrismaService } from '../prisma.service';

const configStub = {
  get: jest.fn((key: string) =>
    key === 'PALAZZO_ALLOWED_URLS' ? 'http://palazzo.test:3100' : undefined,
  ),
  getOrThrow: jest.fn(),
};
const flightStub = {};

// External collaborators that other application modules provide globally.
@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: configStub },
    { provide: FlightService, useValue: flightStub },
  ],
  exports: [ConfigService, FlightService],
})
class RadioModuleCoverageHostModule {}

describe('RadioModule wiring', () => {
  it('declares the controllers and providers and is global', () => {
    expect(Reflect.getMetadata('__module:global__', RadioModule)).toBe(true);
    expect(Reflect.getMetadata('controllers', RadioModule)).toEqual([
      RadioController,
      RadioMonitorController,
    ]);
    expect(Reflect.getMetadata('providers', RadioModule)).toEqual(
      expect.arrayContaining([
        RadioService,
        RadioMonitorService,
        SongExecutionEngine,
        NowPlayingPublisherService,
        PalazzoRadioTelemetryService,
        RadioMetricsService,
        RadioOutputConfidenceService,
        PalazzoMachineClient,
        PrismaService,
      ]),
    );
    expect(Reflect.getMetadata('exports', RadioModule)).toEqual([
      RadioService,
      SongExecutionEngine,
      NowPlayingPublisherService,
      PalazzoRadioTelemetryService,
      RadioMetricsService,
      RadioOutputConfidenceService,
      PalazzoMachineClient,
    ]);
  });

  it('compiles and resolves the real providers with infrastructure overridden', async () => {
    const stub = {};
    const builder = Test.createTestingModule({
      imports: [RadioModuleCoverageHostModule, RadioModule],
    })
      .overrideProvider(PrismaService)
      .useValue(stub);
    const moduleRef = await builder.compile();
    expect(moduleRef.get(RadioService)).toBeInstanceOf(RadioService);
    expect(moduleRef.get(RadioMonitorService)).toBeInstanceOf(
      RadioMonitorService,
    );
    expect(moduleRef.get(PrismaService)).toBe(stub);
    expect(moduleRef.get(SongExecutionEngine)).toBeInstanceOf(
      SongExecutionEngine,
    );
    expect(moduleRef.get(PalazzoMachineClient)).toBeInstanceOf(
      PalazzoMachineClient,
    );
    expect(moduleRef.get(RadioController)).toBeInstanceOf(RadioController);
    await moduleRef.close();
  });
});
