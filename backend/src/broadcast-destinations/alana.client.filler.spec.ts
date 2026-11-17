import {
  liveProfileChecksum,
  parseLiveProfile,
  sanitizeAlanaFiller,
  sanitizeAlanaState,
} from './alana.client';

// gaulatti/alcantara#126: the filler acknowledgement and live profile Alana
// reports (pinned contract for gaulatti/alana#29), reduced to bounded fields.

const PROFILE = {
  width: 1280,
  height: 720,
  fps: 25,
  videoBitrate: '3000k',
  audioRate: 48000,
  audioChannels: 2,
  audioBitrate: '128k',
  gop: 50,
  loopSeconds: 8,
};

describe('Alana filler acknowledgement', () => {
  it('keeps only the bounded binding fields', () => {
    expect(
      sanitizeAlanaFiller({
        version: 'filler-tv-1',
        status: 'ready',
        ready: true,
        sourceId: 'slate',
        sourceSha256: 'a'.repeat(64),
        profileChecksum: 'b'.repeat(64),
        downloadUrl: 'https://signed.example.test/x',
        profile: PROFILE,
      }),
    ).toEqual({
      version: 'filler-tv-1',
      status: 'ready',
      ready: true,
      sourceId: 'slate',
      sourceSha256: 'a'.repeat(64),
      profileChecksum: 'b'.repeat(64),
    });
  });

  it('drops malformed identity fields and refuses a non-acknowledgement', () => {
    expect(
      sanitizeAlanaFiller({
        version: 'filler-tv-1',
        status: 7,
        ready: 'yes',
        sourceId: 'x'.repeat(201),
        sourceSha256: 'not-hex',
        profileChecksum: 'B'.repeat(64),
      }),
    ).toEqual({ version: 'filler-tv-1', status: 'unknown', ready: false });
    expect(sanitizeAlanaFiller(null)).toBeNull();
    expect(sanitizeAlanaFiller(['filler'])).toBeNull();
    expect(sanitizeAlanaFiller({ ready: true })).toBeNull();
  });

  it('carries the lifecycle active and pending fillers only when Alana reports them', () => {
    const state = sanitizeAlanaState({
      activeFiller: { version: 'filler-tv-0', status: 'ready', ready: true },
      pendingFiller: {
        version: 'filler-tv-1',
        status: 'preparing',
        ready: false,
      },
    });
    expect(state.activeFiller).toEqual({
      version: 'filler-tv-0',
      status: 'ready',
      ready: true,
    });
    expect(state.pendingFiller).toEqual({
      version: 'filler-tv-1',
      status: 'preparing',
      ready: false,
    });
    const legacy = sanitizeAlanaState({
      activeFiller: null,
      pendingFiller: null,
    });
    expect(legacy).not.toHaveProperty('activeFiller');
    expect(legacy).not.toHaveProperty('pendingFiller');
  });
});

describe('Alana live profile', () => {
  const response = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: 1,
    programId: 'main',
    profile: PROFILE,
    checksum: liveProfileChecksum(PROFILE),
    ...overrides,
  });

  it('accepts a complete self-consistent profile for the program', () => {
    expect(parseLiveProfile(response(), 'main')).toEqual({
      profile: PROFILE,
      checksum: liveProfileChecksum(PROFILE),
    });
    expect(liveProfileChecksum(PROFILE)).toBe(
      liveProfileChecksum({ ...PROFILE }),
    );
  });

  it.each([
    ['a missing profile', { profile: undefined }],
    ['an extra profile key', { profile: { ...PROFILE, crf: 18 } }],
    ['a missing profile key', { profile: { ...PROFILE, gop: undefined } }],
    ['a zero dimension', { profile: { ...PROFILE, width: 0 } }],
    ['a numeric bitrate', { profile: { ...PROFILE, audioBitrate: 128 } }],
    ['a missing checksum', { checksum: undefined }],
  ])('refuses %s', (_name, overrides) => {
    expect(
      parseLiveProfile(JSON.parse(JSON.stringify(response(overrides))), 'main'),
    ).toBeNull();
  });
});
