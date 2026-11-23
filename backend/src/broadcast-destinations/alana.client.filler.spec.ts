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

// gaulatti/ariston#217: a profile key Alcantara does not know no longer
// refuses the profile. The checksum covers the profile as received.
describe('Alana live profile: unknown keys', () => {
  const extended = { ...PROFILE, crf: 18, colorSpace: 'bt709' };
  const response = (overrides: Record<string, unknown> = {}) => ({
    contractVersion: 1,
    programId: 'main',
    profile: extended,
    checksum: liveProfileChecksum(extended as typeof PROFILE),
    ...overrides,
  });

  it('accepts the profile as received and reports each unknown key', () => {
    let unknown = 0;
    const parsed = parseLiveProfile(response(), 'main', () => (unknown += 1));
    expect(parsed).toEqual({
      profile: extended,
      checksum: liveProfileChecksum(extended as typeof PROFILE),
    });
    expect(unknown).toBe(2);
  });

  it('reports nothing for the nine known keys', () => {
    let unknown = 0;
    parseLiveProfile(
      {
        contractVersion: 1,
        programId: 'main',
        profile: PROFILE,
        checksum: liveProfileChecksum(PROFILE),
      },
      'main',
      () => (unknown += 1),
    );
    expect(unknown).toBe(0);
  });

  it.each([
    [
      'a checksum over the known keys only',
      { checksum: liveProfileChecksum(PROFILE) },
    ],
    ['another contract version', { contractVersion: 2 }],
    ['another program', { programId: 'other' }],
    [
      'a missing known key next to unknown ones',
      {
        profile: { ...extended, fps: undefined },
      },
    ],
  ])('still refuses %s', (_name, overrides) => {
    let unknown = 0;
    expect(
      parseLiveProfile(
        JSON.parse(JSON.stringify(response(overrides))),
        'main',
        () => (unknown += 1),
      ),
    ).toBeNull();
    expect(unknown).toBe(0);
  });
});
