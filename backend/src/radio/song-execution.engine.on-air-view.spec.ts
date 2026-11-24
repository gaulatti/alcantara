/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- the engine state map is private and set directly. */
import { SongExecutionEngine } from './song-execution.engine';
import { RadioMetricsService } from './radio-metrics.service';

// gaulatti/alcantara#214: the read-only account of a program the MCP tools use.

function engine() {
  return new SongExecutionEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new RadioMetricsService(),
  );
}

describe('SongExecutionEngine.getOnAirView', () => {
  it('reads a program the engine knows nothing of as idle and unfrozen', () => {
    expect(engine().getOnAirView('p1')).toEqual({
      playbackRequestId: null,
      songId: null,
      nextSongId: null,
      next: null,
      mode: null,
      frozen: false,
    });
  });

  it('reads the rotation mode and the frozen state of a program with no song or announcement', () => {
    const e = engine();
    e.handleSequenceUpdated('p1', {
      mode: 'shuffle',
      loop: true,
      intervalMs: 500,
      items: [],
    });
    e.registerRadioProgram('p1');
    e.handlePalazzoStatus('p1', { connection: 'unavailable' } as never);
    expect(e.getOnAirView('p1')).toEqual({
      playbackRequestId: null,
      songId: null,
      nextSongId: null,
      next: null,
      mode: 'shuffle',
      frozen: true,
    });
  });

  it('reads the song on air and the announced next song, never its token or address', () => {
    const e = engine();
    (e as any).states.set('p1', {
      sequence: null,
      frozen: false,
      activeSong: {
        token: 'secret-token',
        audioUrl: 'https://media.test/a.mp3?token=secret',
        playbackRequestId: 'req-1',
        songId: null,
      },
      announcement: {
        playbackId: 'next-1',
        status: 'pending',
        title: 'T',
        artist: 'A',
        audioUrl: 'https://media.test/b.mp3?token=secret',
        itemId: 'catalog:5',
      },
    });
    const view = e.getOnAirView('p1');
    expect(view).toEqual({
      playbackRequestId: 'req-1',
      songId: null,
      nextSongId: 5,
      next: {
        playbackId: 'next-1',
        status: 'pending',
        title: 'T',
        artist: 'A',
      },
      mode: null,
      frozen: false,
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('tells the catalog song of the announced next song, from a catalog entry or a playlist leaf (gaulatti/alcantara#235)', () => {
    const e = engine();
    const announce = (itemId: string, sequence: unknown = null) =>
      (e as any).states.set('p1', {
        sequence,
        frozen: false,
        activeSong: null,
        announcement: {
          playbackId: 'n',
          status: 'accepted',
          title: 'T',
          artist: 'A',
          itemId,
        },
      });
    announce('catalog:42');
    expect(e.getOnAirView('p1').nextSongId).toBe(42);
    announce('catalog:nope');
    expect(e.getOnAirView('p1').nextSongId).toBeNull();
    announce('catalog:0');
    expect(e.getOnAirView('p1').nextSongId).toBeNull();
    announce('leaf-1', {
      mode: 'manual',
      activeItemId: 'leaf-1',
      items: [
        {
          id: 'leaf-1',
          kind: 'preset',
          songId: 7,
          artist: 'A',
          title: 'T',
          coverUrl: '',
        },
      ],
    });
    expect(e.getOnAirView('p1').nextSongId).toBe(7);
    announce('leaf-unknown');
    expect(e.getOnAirView('p1').nextSongId).toBeNull();
  });
});
