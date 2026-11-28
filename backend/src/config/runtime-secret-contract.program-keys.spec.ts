import { parseRuntimeSecretPayload } from './runtime-secret-contract';

// The holders' program keys in the runtime secret (gaulatti/alcantara#884). Fictional values, built here.
const REQUIRED = {
  palazzoAllowedUrls: 'http://palazzo:3100',
  alanaControlToken: 'a'.repeat(64),
  alanaControlUrl: 'http://alana:8080',
  externalSourceConfigCurrentVersion: '1',
  externalSourceConfigKeys:
    '{"1":"YWxjYW50YXJhLWxvY2FsLXNvdXJjZS1rZXktMDAwMDA="}',
};
const KEY_A = `alrk_${'a'.repeat(43)}`;
const parse = (
  webrtcProgramKeys: unknown,
  options?: { strictWebrtc: boolean },
) =>
  parseRuntimeSecretPayload(
    JSON.stringify({ ...REQUIRED, webrtcProgramKeys }),
    options,
  );

describe('runtime secret program keys', () => {
  it('takes an object of program ids to renderer keys', () => {
    expect(
      parse({ 'station-a': KEY_A, 'news.fm': KEY_A }).webrtcProgramKeys,
    ).toEqual({ 'station-a': KEY_A, 'news.fm': KEY_A });
    expect(parse({}).webrtcProgramKeys).toEqual({});
    expect(
      parseRuntimeSecretPayload(JSON.stringify(REQUIRED)).webrtcProgramKeys,
    ).toBeUndefined();
  });

  it.each([
    ['a list', [KEY_A]],
    ['a string', KEY_A],
    ['null', null],
    ['a program id with a slash', { 'news/main': KEY_A }],
    ['a key of another shape', { 'station-a': 'not-a-renderer-key' }],
    ['a key that is not a string', { 'station-a': 4 }],
  ])(
    'refuses %s by field name, and drops it when WebRTC is optional',
    (_name, value) => {
      expect(() => parse(value)).toThrow(
        'field webrtcProgramKeys is malformed',
      );
      expect(() => parse(value)).not.toThrow(KEY_A);
      const lenient = parse(value, { strictWebrtc: false });
      expect(lenient.webrtcProgramKeys).toBeUndefined();
      expect((lenient as { webrtcProblem?: string }).webrtcProblem).toContain(
        'webrtcProgramKeys',
      );
    },
  );
});
