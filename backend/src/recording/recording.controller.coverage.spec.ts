import { BadRequestException } from '@nestjs/common';
import type { AlanaRecordingClient } from './alana-recording.client';
import { RecordingController } from './recording.controller';

describe('RecordingController coverage', () => {
  const status = jest.fn() as jest.MockedFunction<
    AlanaRecordingClient['status']
  >;
  const command = jest.fn() as jest.MockedFunction<
    AlanaRecordingClient['command']
  >;
  const controller = new RecordingController({
    status,
    command,
  } as unknown as AlanaRecordingClient);

  beforeEach(() => jest.clearAllMocks());

  it('reads status for a trimmed program id', async () => {
    const result = { state: 'idle' } as never;
    status.mockResolvedValue(result);
    await expect(controller.status('  modoitaliano  ')).resolves.toBe(result);
    expect(status).toHaveBeenCalledWith('modoitaliano');
  });

  it.each([
    ['empty after trimming', '   '],
    ['too long', 'a'.repeat(201)],
    ['contains a slash', 'a/b'],
    ['contains a control character', 'a\u0007b'],
    ['contains DEL', 'a\u007fb'],
  ])('rejects a program id that is %s', (_name, programId) => {
    expect(() => void controller.status(programId)).toThrow(
      new BadRequestException({ error: 'INVALID_PROGRAM_ID' }),
    );
    expect(status).not.toHaveBeenCalled();
  });

  it('accepts a 200 character program id with the boundary character 0x20', () => {
    const programId = `${'a'.repeat(100)} ${'b'.repeat(99)}`;
    expect(programId).toHaveLength(200);
    void controller.status(programId);
    expect(status).toHaveBeenCalledWith(programId);
  });

  it('trims the idempotency key and rejects a missing one with a specific error', () => {
    void controller.start('p', '  key-1  ');
    expect(command).toHaveBeenCalledWith('p', 'start', 'key-1');
    expect(() => void controller.stop('p', undefined)).toThrow(
      new BadRequestException({
        error: 'A_BOUNDED_IDEMPOTENCY_KEY_IS_REQUIRED',
      }),
    );
  });
});
