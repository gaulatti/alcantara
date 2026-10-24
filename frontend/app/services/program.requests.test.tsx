import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignSceneToProgram, fetchMediaGroups, fetchProgramAudioBusSettings, fetchProgramAudioMeter,
  fetchProgramSongPlayback, fetchProgramState, fetchSceneInstantPlayback, persistMixerSettings,
  saveProgramAudioBusSongSequence, stageSceneForProgram, stopSceneInstant, takeSceneInstant, takeSongOffAir,
} from './program';

vi.mock('../utils/apiBaseUrl', () => ({ apiUrl: (path: string) => `https://api.example${path}` }));
afterEach(() => vi.unstubAllGlobals());
const root = '/program/show%2Fa';
const mixerSettings = { mainMasterVolume: 0.5, mixerChannels: [{ id: 'song', volume: 0.75 }] };
const sequence = { mode: 'manual', items: [] };
const json = (body: object) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (body: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cases = [
  { name: 'state snapshot', run: () => fetchProgramState('show/a'), path: `${root}/state`, init: undefined, result: { version: 3, activeSceneId: 7 } },
  { name: 'audio bus snapshot', run: () => fetchProgramAudioBusSettings('show/a'), path: `${root}/audio-bus`, init: undefined, result: { mixerSettings } },
  { name: 'mixer settings', run: () => persistMixerSettings('show/a', mixerSettings), path: `${root}/audio-bus`, init: json({ mixerSettings }), result: { mixerSettings } },
  { name: 'song sequence', run: () => saveProgramAudioBusSongSequence('show/a', sequence), path: `${root}/audio-bus`, init: json({ songSequence: sequence }), result: { songSequence: sequence } },
  { name: 'meter snapshot', run: () => fetchProgramAudioMeter('show/a'), path: `${root}/audio-meter`, init: undefined, result: { channels: [{ id: 'song', level: 0.5 }] } },
  { name: 'song playback snapshot', run: () => fetchProgramSongPlayback('show/a'), path: `${root}/song-playback`, init: undefined, result: { isPlaying: false } },
  { name: 'song off-air', run: () => takeSongOffAir('show/a'), path: `${root}/song/off-air`, init: { method: 'POST' }, result: undefined },
  { name: 'instant snapshot', run: () => fetchSceneInstantPlayback('show/a'), path: `${root}/scene-instant`, init: undefined, result: { sceneId: 7, instantId: 8 } },
  { name: 'take instant', run: () => takeSceneInstant('show/a', 7, 8), path: `${root}/scene-instant/take`, init: post({ sceneId: 7, instantId: 8 }), result: { sceneId: 7, instantId: 8 } },
  { name: 'stop instant', run: () => stopSceneInstant('show/a'), path: `${root}/scene-instant/stop`, init: { method: 'POST' }, result: { instantId: null } },
  { name: 'assign scene', run: () => assignSceneToProgram('show/a', 7), path: `${root}/scenes`, init: post({ sceneId: 7 }), result: undefined },
  { name: 'stage scene', run: () => stageSceneForProgram('show/a', 7), path: `${root}/stage`, init: post({ sceneId: 7 }), result: undefined },
  { name: 'media group snapshot', run: () => fetchMediaGroups('show/a'), path: `${root}/media-groups`, init: undefined, result: [{ id: 9 }] },
];

describe('program-scoped control and telemetry requests', () => {
  it.each(cases)('$name preserves the target and authoritative producer result', async ({ run, path, init, result }) => {
    const request = vi.fn(async () => new Response(result === undefined ? null : JSON.stringify(result)));
    vi.stubGlobal('fetch', request);
    await expect(run()).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(`https://api.example${path}`, ...(init === undefined ? [] : [init]));
  });
  it.each(cases)('$name never treats failed transport as accepted control state', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    await expect(run()).rejects.toThrow('HTTP 503');
  });
  it('can explicitly clear scene staging and choose no scene instant', async () => {
    const request = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', request);
    await stageSceneForProgram('main', null);
    expect(request).toHaveBeenLastCalledWith('https://api.example/program/main/stage', post({ sceneId: null }));
    await takeSceneInstant('main', 7, null);
    expect(request).toHaveBeenLastCalledWith('https://api.example/program/main/scene-instant/take', post({ sceneId: 7, instantId: null }));
  });
});
