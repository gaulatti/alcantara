import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { RadioMonitorController } from './radio-monitor.controller';

function build() {
  const monitor = { issue: jest.fn(), open: jest.fn() };
  const controller = new RadioMonitorController(monitor as any);
  const raw = new EventEmitter();
  return { controller, monitor, raw, reply: { raw: raw as any } };
}

describe('RadioMonitorController coverage', () => {
  it('delegates ticket issuing to the monitor service', () => {
    const { controller, monitor } = build();
    monitor.issue.mockReturnValue('issued');
    expect(controller.issue('main')).toBe('issued');
    expect(monitor.issue).toHaveBeenCalledWith('main');
  });

  it('streams audio, aborts on reply close and detaches when the stream closes', async () => {
    const { controller, monitor, raw, reply } = build();
    const stream = new PassThrough();
    monitor.open.mockResolvedValue({ stream, type: 'audio/mpeg' });
    const file = await controller.audio('main', 't1', reply);
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders().type).toBe('audio/mpeg');
    const signal: AbortSignal = monitor.open.mock.calls[0][2];
    expect(monitor.open).toHaveBeenCalledWith('main', 't1', signal);
    expect(raw.listenerCount('close')).toBe(1);
    raw.emit('close');
    expect(signal.aborted).toBe(true);
    stream.emit('close');
    expect(raw.listenerCount('close')).toBe(0);
  });

  it('detaches the close listener and rethrows when opening fails', async () => {
    const { controller, monitor, raw, reply } = build();
    const failure = new Error('denied');
    monitor.open.mockRejectedValue(failure);
    await expect(controller.audio('main', 't1', reply)).rejects.toBe(failure);
    expect(raw.listenerCount('close')).toBe(0);
  });
});
