import { NotFoundException } from '@nestjs/common';
import { ALCANTARA_PERMISSIONS } from '../../auth/permissions';
import { McpToolError } from '../contract';
import { RadioMcpTools } from './radio';
import { specNamed } from './capabilities.testing';

// gaulatti/alcantara#300: two read-only radio capabilities. They read the engine's
// on-air view and the program's audio meter; no write path is involved.

const knownProgram = { getRadioSettings: () => Promise.resolve({}) };

function tools(engine: object, programs: object, radio: object = knownProgram) {
  return new RadioMcpTools(
    radio as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    engine as never,
    programs as never,
  );
}

const ctx = {} as never;

describe('radio_get_playback_state', () => {
  it('reports the song on air, its elapsed time, the next song and the mode', async () => {
    const engine = {
      getOnAirView: () => ({
        playbackRequestId: 'pb-1',
        songId: 9,
        next: {
          playbackId: 'pb-2',
          status: 'accepted',
          title: 'Fictional next',
          artist: 'Fictional artist',
        },
        mode: 'autoplay',
        frozen: false,
      }),
      getPlaybackState: () => ({
        positionMs: 61_000,
        durationMs: 180_000,
        progress: 0.34,
        introStatus: 'none',
        telemetryStale: false,
        title: 'Fictional song',
        artist: 'Fictional artist',
      }),
    };
    const spec = specNamed(
      tools(engine, {}).specs(),
      'radio_get_playback_state',
    );
    const outcome = await spec.run({ program_id: 'main' }, ctx);
    // Prompt-injection boundary: title and artist are reachable only under `untrusted`.
    const withoutUntrusted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(withoutUntrusted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== 'untrusted')
                .map(([key, inner]) => [key, withoutUntrusted(inner)]),
            )
          : value;
    const plain = JSON.stringify(withoutUntrusted(outcome.result));
    expect(plain).not.toContain('Fictional song');
    expect(plain).not.toContain('Fictional next');
    expect(plain).not.toContain('Fictional artist');
    expect(outcome.result).toMatchObject({
      on_air: {
        untrusted: { title: 'Fictional song', artist: 'Fictional artist' },
      },
      next: {
        untrusted: { title: 'Fictional next', artist: 'Fictional artist' },
      },
    });
    expect(outcome.result).toMatchObject({
      program_id: 'main',
      on_air: {
        playback_request_id: 'pb-1',
        elapsed_ms: 61_000,
        duration_ms: 180_000,
        progress: 0.34,
        intro_status: 'none',
        telemetry_stale: false,
      },
      next: { playback_id: 'pb-2', status: 'accepted' },
      mode: 'autoplay',
      frozen: false,
    });
  });

  it('reports on_air as null and next as null when nothing is playing', async () => {
    const engine = {
      getOnAirView: () => ({
        playbackRequestId: null,
        songId: null,
        next: null,
        mode: null,
        frozen: true,
      }),
      getPlaybackState: () => null,
    };
    const spec = specNamed(
      tools(engine, {}).specs(),
      'radio_get_playback_state',
    );
    const outcome = await spec.run({ program_id: 'main' }, ctx);
    expect(outcome.result).toMatchObject({
      on_air: null,
      next: null,
      mode: null,
      frozen: true,
    });
  });
});

describe('radio_get_audio_levels', () => {
  it('reports vu, peak and peak hold for every channel with the update time', async () => {
    const programs = {
      getProgramAudioMeter: () =>
        Promise.resolve({
          song: { vu: 0.4, peak: 0.6, peakHold: 0.7 },
          instants: { vu: 0.1, peak: 0.2, peakHold: 0.3 },
          sceneInstant: { vu: 0, peak: 0, peakHold: 0 },
          main: { vu: 0.5, peak: 0.8, peakHold: 0.9 },
          updatedAt: '2026-11-22T12:00:00.000Z',
          version: 4,
        }),
    };
    const spec = specNamed(
      tools({}, programs).specs(),
      'radio_get_audio_levels',
    );
    const outcome = await spec.run({ program_id: 'main' }, ctx);
    expect(outcome.result).toEqual({
      program_id: 'main',
      updated_at: '2026-11-22T12:00:00.000Z',
      channels: {
        song: { vu: 0.4, peak: 0.6, peak_hold: 0.7 },
        instants: { vu: 0.1, peak: 0.2, peak_hold: 0.3 },
        scene_instant: { vu: 0, peak: 0, peak_hold: 0 },
        main: { vu: 0.5, peak: 0.8, peak_hold: 0.9 },
      },
    });
  });

  it('is a read on the radio permission, not a write', () => {
    const specs = tools({}, {}).specs();
    for (const name of ['radio_get_playback_state', 'radio_get_audio_levels']) {
      const spec = specNamed(specs, name);
      expect(spec.permission).toBe(ALCANTARA_PERMISSIONS.radio.read);
      expect(spec.tier).toBe('R');
    }
  });

  it('answers not_found for an unknown program, as get_on_air does', async () => {
    const radio = {
      getRadioSettings: () =>
        Promise.reject(new NotFoundException('no such program')),
    };
    const spec = specNamed(
      tools({ getOnAirView: () => ({}) }, {}, radio).specs(),
      'radio_get_playback_state',
    );
    await expect(
      spec.run({ program_id: 'missing' }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      spec.run({ program_id: 'missing' }, ctx),
    ).rejects.toBeInstanceOf(McpToolError);
  });

  it('reports an idle program with on_air null, not an error', async () => {
    const engine = {
      getOnAirView: () => ({
        playbackRequestId: null,
        songId: null,
        next: null,
        mode: 'manual',
        frozen: false,
      }),
      getPlaybackState: () => null,
    };
    const spec = specNamed(
      tools(engine, {}).specs(),
      'radio_get_playback_state',
    );
    const outcome = await spec.run({ program_id: 'main' }, ctx);
    expect(outcome.result).toMatchObject({
      on_air: null,
      next: null,
      mode: 'manual',
    });
  });

  it('reports on_air null when a playback request exists without its playback state', async () => {
    const engine = {
      getOnAirView: () => ({
        playbackRequestId: 'pb-9',
        songId: 9,
        next: null,
        mode: 'autoplay',
        frozen: false,
      }),
      getPlaybackState: () => null,
    };
    const spec = specNamed(
      tools(engine, {}).specs(),
      'radio_get_playback_state',
    );
    const outcome = await spec.run({ program_id: 'main' }, ctx);
    expect(outcome.result).toMatchObject({ on_air: null });
  });
});
