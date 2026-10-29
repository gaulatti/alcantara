import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ObservabilityModule } from '../observability/observability.module';
import { AlanaRecordingClient } from './alana-recording.client';
import { RecordingController } from './recording.controller';
import { RecordingModule } from './recording.module';

describe('RecordingModule', () => {
  it('compiles with the real client wired into the controller and exported', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ObservabilityModule,
        RecordingModule,
      ],
    }).compile();

    const client = moduleRef.get(AlanaRecordingClient);
    const controller = moduleRef.get(RecordingController);
    expect(client).toBeInstanceOf(AlanaRecordingClient);
    expect(controller).toBeInstanceOf(RecordingController);

    const status = jest
      .spyOn(client, 'status')
      .mockResolvedValue({ state: 'idle' } as never);
    await expect(controller.status(' modoitaliano ')).resolves.toEqual({
      state: 'idle',
    });
    expect(status).toHaveBeenCalledWith('modoitaliano');
    await moduleRef.close();
  });
});
