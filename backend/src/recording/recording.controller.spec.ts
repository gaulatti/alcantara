import { BadRequestException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../auth/permissions';
import { REQUIRED_PERMISSION_KEY } from '../auth/require-permission.decorator';
import type { AlanaRecordingClient } from './alana-recording.client';
import { RecordingController } from './recording.controller';

function controllerMethod(name: 'start' | 'stop'): object {
  const value: unknown = Object.getOwnPropertyDescriptor(
    RecordingController.prototype,
    name,
  )?.value;
  if (typeof value !== 'function') throw new Error(`Missing ${name} handler`);
  return value;
}

describe('RecordingController', () => {
  const status = jest.fn<AlanaRecordingClient['status']>();
  const command = jest.fn<AlanaRecordingClient['command']>();
  const recording = {
    status,
    command,
  } as unknown as AlanaRecordingClient;
  const controller = new RecordingController(recording);

  beforeEach(() => jest.clearAllMocks());

  it('requires read access for status and operate access for mutations', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, RecordingController),
    ).toBe(ALCANTARA_PERMISSIONS.program.read);
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controllerMethod('start')),
    ).toBe(ALCANTARA_PERMISSIONS.program.operate);
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controllerMethod('stop')),
    ).toBe(ALCANTARA_PERMISSIONS.program.operate);
  });

  it('passes the exact caller key through for replay-safe commands', () => {
    void controller.start('modoitaliano', 'recording-start-1');
    void controller.stop('modoitaliano', 'recording-stop-1');

    expect(command).toHaveBeenNthCalledWith(
      1,
      'modoitaliano',
      'start',
      'recording-start-1',
    );
    expect(command).toHaveBeenNthCalledWith(
      2,
      'modoitaliano',
      'stop',
      'recording-stop-1',
    );
  });

  it('rejects missing, malformed, or oversized identifiers before Alana', () => {
    expect(() => void controller.start('modoitaliano', undefined)).toThrow(
      BadRequestException,
    );
    expect(
      () => void controller.stop('modo/italiano', 'recording-stop-1'),
    ).toThrow(BadRequestException);
    expect(
      () => void controller.start('modoitaliano', 'contains spaces'),
    ).toThrow(BadRequestException);
    expect(command).not.toHaveBeenCalled();
  });
});
