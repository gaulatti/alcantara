import { decodeProgramRealtimeData } from './program.realtime.service';

describe('program realtime payload decoding', () => {
  const message = JSON.stringify({ type: 'heartbeat', label: 'Café 🚦' });
  const bytes = Buffer.from(message, 'utf8');

  it('preserves textual compatibility messages', () => {
    expect(decodeProgramRealtimeData(message)).toBe(message);
  });
  it('decodes native nodebuffer messages as UTF-8', () => {
    expect(decodeProgramRealtimeData(bytes)).toBe(message);
  });
  it('assembles fragmented native buffers before UTF-8 decoding, including split multibyte characters', () => {
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    expect(
      decodeProgramRealtimeData([
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]),
    ).toBe(message);
  });
  it('accepts the native arraybuffer representation without changing JSON content', () => {
    expect(decodeProgramRealtimeData(Uint8Array.from(bytes).buffer)).toBe(
      message,
    );
  });
  it('preserves empty payloads so the actual message handler can ignore them', () => {
    expect(decodeProgramRealtimeData('')).toBe('');
    expect(decodeProgramRealtimeData(Buffer.alloc(0))).toBe('');
    expect(decodeProgramRealtimeData([])).toBe('');
    expect(decodeProgramRealtimeData(new ArrayBuffer(0))).toBe('');
  });
});
