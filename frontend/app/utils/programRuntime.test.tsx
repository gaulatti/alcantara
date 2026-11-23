import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSceneInstantPlaybackToken,
  createInstantAudioMeterContext,
  createMeterChannelBallistics,
  createProgramMeterBallisticsState,
  flattenProgramSongItems,
  getProgramMixerChannel,
  normalizeBroadcastSettings,
  normalizeMasterVolume,
  normalizeMixerToggle,
  normalizeProgramAudioBusSettings,
  normalizeProgramAudioMixerSettings,
  normalizeProgramMixerChannels,
  normalizeProgramSongPlaylist,
  normalizeSceneInstantAssetId,
  normalizeSceneInstantNumericId,
  normalizeSceneInstantTimestamp,
  normalizeSlideshowLabelId,
  normalizeSlideshowMediaGroupId,
  normalizeUpdateVersion,
  readProgramTopicVersion,
  resolveProgramUpdateTopicFromType,
  sceneIncludesVideoStream,
  type ProgramMixerChannel,
  type ProgramUpdateTopic,
  type Scene
} from './programRuntime';
import {
  createProgramSongSequence,
  createProgramSongSequenceItem,
  type ProgramSongSequence,
  type ProgramSongSequenceItem
} from './programSequence';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which program updates the on-air page applies', () => {
  it('reads a version as a whole non-negative number, otherwise none', () => {
    expect(normalizeUpdateVersion(7)).toBe(7);
    expect(normalizeUpdateVersion('12')).toBe(12);
    expect(normalizeUpdateVersion(3.9)).toBe(3);
    expect(normalizeUpdateVersion(0)).toBe(0);
    expect(normalizeUpdateVersion(-1)).toBeNull();
    expect(normalizeUpdateVersion('not a number')).toBeNull();
    expect(normalizeUpdateVersion(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('files every message type under the topic whose version orders it', () => {
    const expected: Record<string, ProgramUpdateTopic> = {
      program_state_snapshot: 'state',
      scene_change: 'state',
      scene_staged: 'state',
      fade_to_black: 'state',
      scene_update: 'state',
      scene_cleared: 'state',
      program_scenes_changed: 'state',
      program_stingers_changed: 'state',
      audio_bus_snapshot: 'audioBus',
      audio_bus_update: 'audioBus',
      audio_meter_update: 'audioMeter',
      song_playback_update: 'songPlayback',
      song_off_air: 'songPlayback',
      scene_instant_state: 'sceneInstant',
      scene_instant_take: 'sceneInstant',
      scene_instant_stop: 'sceneInstant',
      broadcast_settings_snapshot: 'broadcastSettings',
      broadcast_settings_update: 'broadcastSettings'
    };
    for (const [type, topic] of Object.entries(expected)) {
      expect(resolveProgramUpdateTopicFromType(type)).toBe(topic);
    }
    expect(resolveProgramUpdateTopicFromType('instant_play')).toBeNull();
    expect(resolveProgramUpdateTopicFromType(42)).toBeNull();
  });

  it('prefers the version on the message itself, then the one inside its topic payload, then the flat field', () => {
    const cases: Array<[ProgramUpdateTopic, Record<string, unknown>, Record<string, unknown>]> = [
      ['state', { state: { version: 4 } }, { stateVersion: 5 }],
      ['audioBus', { settings: { version: 4 } }, { audioBusVersion: 5 }],
      ['audioMeter', { levels: { version: 4 } }, { audioMeterVersion: 5 }],
      ['songPlayback', { playback: { version: 4 } }, { songPlaybackVersion: 5 }],
      ['sceneInstant', { playback: { version: 4 } }, { sceneInstantVersion: 5 }],
      ['broadcastSettings', { settings: { version: 4 } }, { broadcastSettingsVersion: 5 }]
    ];
    for (const [topic, nested, flat] of cases) {
      expect(readProgramTopicVersion(topic, { version: 9, ...nested })).toBe(9);
      expect(readProgramTopicVersion(topic, nested)).toBe(4);
      expect(readProgramTopicVersion(topic, flat)).toBe(5);
      expect(readProgramTopicVersion(topic, {})).toBeNull();
    }
    expect(readProgramTopicVersion('state', null)).toBeNull();
    expect(readProgramTopicVersion('state', [1])).toBeNull();
    expect(readProgramTopicVersion('state', 'x')).toBeNull();
    expect(readProgramTopicVersion('nothing' as ProgramUpdateTopic, { stateVersion: 1 })).toBeNull();
  });
});

describe('level meters', () => {
  it('start silent on every channel with no tick recorded', () => {
    expect(createMeterChannelBallistics()).toEqual({ vu: 0, peak: 0, peakHold: 0, peakHoldAtMs: 0 });
    const state = createProgramMeterBallisticsState();
    expect(state.lastTickAtMs).toBeNull();
    for (const channel of [state.song, state.instants, state.sceneInstant, state.main]) {
      expect(channel).toEqual(createMeterChannelBallistics());
    }
    expect(state.song).not.toBe(state.main);
  });

  it('opens a meter context from AudioContext, then webkitAudioContext, and none when unavailable or it throws', () => {
    class Standard {}
    vi.stubGlobal('AudioContext', Standard);
    expect(createInstantAudioMeterContext()).toBeInstanceOf(Standard);

    class Legacy {}
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', Legacy);
    expect(createInstantAudioMeterContext()).toBeInstanceOf(Legacy);

    vi.stubGlobal('webkitAudioContext', undefined);
    expect(createInstantAudioMeterContext()).toBeNull();

    vi.stubGlobal('AudioContext', class {
      constructor() {
        throw new Error('blocked');
      }
    });
    expect(createInstantAudioMeterContext()).toBeNull();
  });

  it('opens no meter context without a window', () => {
    vi.stubGlobal('window', undefined);
    expect(createInstantAudioMeterContext()).toBeNull();
  });
});

function song(id: string): ProgramSongSequenceItem {
  return { ...createProgramSongSequenceItem('preset'), id } as ProgramSongSequenceItem;
}

function nested(id: string, items: ProgramSongSequenceItem[]): ProgramSongSequenceItem {
  const item = createProgramSongSequenceItem('sequence') as Extract<ProgramSongSequenceItem, { kind: 'sequence' }>;
  return { ...item, id, sequence: { ...item.sequence, items } };
}

function sequence(items: ProgramSongSequenceItem[], activeItemId: string | null | undefined): ProgramSongSequence {
  return { ...createProgramSongSequence(), items, activeItemId } as ProgramSongSequence;
}

describe('the song playlist the program plays', () => {
  it('flattens nested sequences into one ordered list of songs', () => {
    const flat = flattenProgramSongItems([song('a'), nested('n', [song('b'), nested('m', [song('c')])]), song('d')]);
    expect(flat.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the active song when it is still in the playlist', () => {
    const result = normalizeProgramSongPlaylist(sequence([song('a'), nested('n', [song('b')])], 'b'));
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.activeItemId).toBe('b');
  });

  it('falls back to the first song when the active one is gone or unset, and keeps an explicit none', () => {
    expect(normalizeProgramSongPlaylist(sequence([song('a'), song('b')], 'gone')).activeItemId).toBe('a');
    expect(normalizeProgramSongPlaylist(sequence([song('a')], undefined)).activeItemId).toBe('a');
    expect(normalizeProgramSongPlaylist(sequence([], 'x')).activeItemId).toBeNull();
    expect(normalizeProgramSongPlaylist(sequence([song('a')], null)).activeItemId).toBeNull();
  });
});

describe('the saved audio bus settings', () => {
  it('turns anything that is not an object into no sequence and no mixer', () => {
    for (const value of [null, undefined, 'x', 0]) {
      expect(normalizeProgramAudioBusSettings(value)).toEqual({ songSequence: null, mixerSettings: null });
    }
  });

  it('reads the mixer only when the settings carry one, and flattens the sequence', () => {
    const withoutMixer = normalizeProgramAudioBusSettings({ songSequence: sequence([nested('n', [song('a')])], 'a') });
    expect(withoutMixer.mixerSettings).toBeNull();
    expect((withoutMixer.songSequence as ProgramSongSequence).items.map((item) => item.id)).toEqual(['a']);

    const withMixer = normalizeProgramAudioBusSettings({ songSequence: 'bad', mixerSettings: { songMasterVolume: 0.5 } });
    expect(withMixer.songSequence).toBeNull();
    expect(withMixer.mixerSettings?.songMasterVolume).toBe(0.5);
  });
});

describe('mixer values', () => {
  it('clamps a volume to 0..1 and uses the fallback for anything else', () => {
    expect(normalizeMasterVolume(0.4)).toBe(0.4);
    expect(normalizeMasterVolume(3)).toBe(1);
    expect(normalizeMasterVolume(-2)).toBe(0);
    expect(normalizeMasterVolume('0.4')).toBe(1);
    expect(normalizeMasterVolume(Number.NaN, 0.25)).toBe(0.25);
  });

  it('keeps a real boolean and uses the fallback for anything else', () => {
    expect(normalizeMixerToggle(true)).toBe(true);
    expect(normalizeMixerToggle(false, true)).toBe(false);
    expect(normalizeMixerToggle('yes')).toBe(false);
    expect(normalizeMixerToggle(undefined, true)).toBe(true);
  });

  it('accepts only positive whole numbers as a media group and non-blank text as a label', () => {
    expect(normalizeSlideshowMediaGroupId(4)).toBe(4);
    expect(normalizeSlideshowMediaGroupId('5')).toBe(5);
    for (const value of [0, -1, 1.5, 'x', null]) {
      expect(normalizeSlideshowMediaGroupId(value)).toBeNull();
    }
    expect(normalizeSlideshowLabelId('  label ')).toBe('label');
    expect(normalizeSlideshowLabelId('   ')).toBeNull();
    expect(normalizeSlideshowLabelId(3)).toBeNull();
  });
});

describe('mixer channels', () => {
  const base: ProgramMixerChannel[] = [
    { id: 'song', name: 'Song', volume: 0.8, muted: false, solo: true },
    { id: 'stream', name: 'Stream', volume: 1, muted: true, solo: false }
  ];

  it('keeps the fallback channels when the saved value is not a list', () => {
    expect(normalizeProgramMixerChannels('x', base)).toBe(base);
  });

  it('overlays a saved channel on the one it names, keeps its other values, and adds new ones', () => {
    const result = normalizeProgramMixerChannels(
      [
        { id: ' song ', volume: 0.3, muted: true },
        { id: 'guest', name: '  Guest mic ', volume: 5, solo: true },
        { id: 'plain' },
        { id: '  ' },
        { name: 'no id' },
        null,
        [1],
        'x'
      ],
      base
    );
    expect(result).toEqual([
      { id: 'song', name: 'Song', volume: 0.3, muted: true, solo: true },
      { id: 'stream', name: 'Stream', volume: 1, muted: true, solo: false },
      { id: 'guest', name: 'Guest mic', volume: 1, muted: false, solo: true },
      { id: 'plain', name: 'plain', volume: 1, muted: false, solo: false }
    ]);
    expect(base[0].volume).toBe(0.8);
  });

  it('finds a channel by id, or describes an open default one', () => {
    expect(getProgramMixerChannel(base, 'stream')).toBe(base[1]);
    expect(getProgramMixerChannel(base, 'other')).toEqual({ id: 'other', name: 'other', volume: 1, muted: false, solo: false });
  });
});

describe('the saved mixer settings', () => {
  it('defaults every fader to full and every switch to off', () => {
    const result = normalizeProgramAudioMixerSettings(undefined);
    expect(result).toMatchObject({
      mainMasterVolume: 1,
      songMasterVolume: 1,
      instantMasterVolume: 1,
      sceneInstantMasterVolume: 1,
      streamMasterVolume: 1,
      songMuted: false,
      instantMuted: false,
      sceneInstantMuted: false,
      streamMuted: false,
      songSolo: false,
      instantSolo: false,
      sceneInstantSolo: false,
      streamSolo: false
    });
    expect(result.mixerChannels.map((channel) => channel.id)).toEqual(['song', 'stream', 'instants', 'sceneInstant']);
  });

  it('builds the channels from the flat fields and lets a saved channel list win', () => {
    const flat = normalizeProgramAudioMixerSettings({
      mainMasterVolume: 0.9,
      songMasterVolume: 0.1,
      instantMasterVolume: 0.2,
      sceneInstantMasterVolume: 0.3,
      streamMasterVolume: 0.4,
      songMuted: true,
      instantMuted: true,
      sceneInstantMuted: true,
      streamMuted: true,
      songSolo: true,
      instantSolo: true,
      sceneInstantSolo: true,
      streamSolo: true
    });
    expect(flat).toMatchObject({
      mainMasterVolume: 0.9,
      songMasterVolume: 0.1,
      instantMasterVolume: 0.2,
      sceneInstantMasterVolume: 0.3,
      streamMasterVolume: 0.4,
      songMuted: true,
      instantMuted: true,
      sceneInstantMuted: true,
      streamMuted: true,
      songSolo: true,
      instantSolo: true,
      sceneInstantSolo: true,
      streamSolo: true
    });

    const saved = normalizeProgramAudioMixerSettings({
      songMasterVolume: 0.1,
      mixerChannels: [{ id: 'song', volume: 0.7 }, { id: 'instants', muted: true }]
    });
    expect(saved.songMasterVolume).toBe(0.7);
    expect(saved.instantMuted).toBe(true);
  });
});

describe('the broadcast settings', () => {
  it('rejects a value that is not an object', () => {
    expect(normalizeBroadcastSettings(null)).toBeNull();
    expect(normalizeBroadcastSettings('x')).toBeNull();
  });

  it('defaults to id 1, no time override and full faders, stamping the update time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    try {
      const result = normalizeBroadcastSettings({});
      expect(result).toMatchObject({
        id: 1,
        timeOverrideEnabled: false,
        timeOverrideStartTime: null,
        timeOverrideStartedAt: null,
        mainMasterVolume: 1,
        songMasterVolume: 1,
        streamMuted: false,
        updatedAt: '2026-11-21T12:00:00.000Z'
      });
      expect(result?.mixerChannels).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries what was saved, with the channel list overriding the flat faders', () => {
    const result = normalizeBroadcastSettings({
      id: 3,
      timeOverrideEnabled: 1,
      timeOverrideStartTime: '08:00',
      timeOverrideStartedAt: '2026-11-21T08:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
      mainMasterVolume: 0.5,
      songMasterVolume: 0.2,
      instantMasterVolume: 0.3,
      sceneInstantMasterVolume: 0.4,
      streamMasterVolume: 0.6,
      songMuted: true,
      instantMuted: true,
      sceneInstantMuted: true,
      streamMuted: true,
      songSolo: true,
      instantSolo: true,
      sceneInstantSolo: true,
      streamSolo: true,
      mixerChannels: [{ id: 'stream', volume: 0.9 }]
    });
    expect(result).toMatchObject({
      id: 3,
      timeOverrideEnabled: true,
      timeOverrideStartTime: '08:00',
      timeOverrideStartedAt: '2026-11-21T08:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
      mainMasterVolume: 0.5,
      songMasterVolume: 0.2,
      instantMasterVolume: 0.3,
      sceneInstantMasterVolume: 0.4,
      streamMasterVolume: 0.9,
      songMuted: true,
      instantMuted: true,
      sceneInstantMuted: true,
      streamMuted: true,
      songSolo: true,
      instantSolo: true,
      sceneInstantSolo: true,
      streamSolo: true
    });
  });
});

describe('scene instants', () => {
  const scene = (componentType: string | undefined): Scene => ({ layout: { componentType } }) as unknown as Scene;

  it('finds a video stream or guest among a scene’s components', () => {
    expect(sceneIncludesVideoStream(scene('header, video-stream'))).toBe(true);
    expect(sceneIncludesVideoStream(scene('webrtc-guest'))).toBe(true);
    expect(sceneIncludesVideoStream(scene('header,,ticker'))).toBe(false);
    expect(sceneIncludesVideoStream(scene(undefined))).toBe(false);
    expect(sceneIncludesVideoStream(null)).toBe(false);
    expect(sceneIncludesVideoStream(undefined)).toBe(false);
  });

  it('accepts only positive numbers as an id, rounding them, and trims timestamps and assets', () => {
    expect(normalizeSceneInstantNumericId(4.6)).toBe(5);
    expect(normalizeSceneInstantNumericId(0.2)).toBeNull();
    expect(normalizeSceneInstantNumericId(-3)).toBeNull();
    expect(normalizeSceneInstantNumericId('4')).toBeNull();
    expect(normalizeSceneInstantNumericId(Number.NaN)).toBeNull();
    expect(normalizeSceneInstantTimestamp(' 2026-11-21T00:00:00Z ')).toBe('2026-11-21T00:00:00Z');
    expect(normalizeSceneInstantTimestamp(5)).toBe('');
    expect(normalizeSceneInstantAssetId(' a1 ')).toBe('a1');
    expect(normalizeSceneInstantAssetId('  ')).toBeNull();
    expect(normalizeSceneInstantAssetId(1)).toBeNull();
  });

  it('names a playback by scene, asset or instant, audio and time so a repeat is recognised', () => {
    expect(buildSceneInstantPlaybackToken(3, 'asset', 9, ' /a.mp3 ', 't1')).toBe('3|asset|/a.mp3|t1');
    expect(buildSceneInstantPlaybackToken(3, null, 9, '/a.mp3', 't1')).toBe('3|9|/a.mp3|t1');
    expect(buildSceneInstantPlaybackToken(null, null, null, '/a.mp3', '')).toBe('none|none|/a.mp3|none');
  });
});
