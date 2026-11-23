import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModoItalianoGiorgiaArtistBumperPlayer from './ModoItalianoGiorgiaArtistBumperPlayer';

// gaulatti/alcantara#184: the player only hands Giorgia's own composition to
// Remotion, configured to run once, silent, with no viewer controls.
const played = vi.hoisted(() => [] as Array<Record<string, unknown>>);
// Giorgia's composition and timing are hers; stand-ins prove they pass
// through unchanged. (Her package imports CSS, which Node cannot load.)
const giorgia = vi.hoisted(() => ({
  ArtistBumper: () => null,
  ARTIST_BUMPER_DURATION_IN_FRAMES: 211,
  ARTIST_BUMPER_FPS: 31,
  ARTIST_BUMPER_WIDTH: 1081,
  ARTIST_BUMPER_HEIGHT: 1351,
}));
vi.mock('@modoitaliano/giorgia/video', () => giorgia);
vi.mock('@remotion/player', () => ({
  Player: (props: Record<string, unknown>) => {
    played.push(props);
    return <div role='presentation' aria-label='Remotion player' />;
  },
}));

afterEach(() => {
  cleanup();
  played.length = 0;
});

it("plays Giorgia's artist bumper once, muted and without controls, holding its last card", () => {
  const inputProps = {
    artist: 'ROB',
    songTitle: 'Cento ragazze',
    images: [
      'https://media.example.test/one.jpg',
      'https://media.example.test/two.jpg',
      'https://media.example.test/three.jpg',
      'https://media.example.test/four.jpg',
    ] as const,
    audioUrl: null,
  };
  render(<ModoItalianoGiorgiaArtistBumperPlayer inputProps={inputProps} />);
  expect(screen.getByLabelText('Remotion player')).toBeInTheDocument();
  expect(played).toHaveLength(1);
  expect(played[0]).toMatchObject({
    component: giorgia.ArtistBumper,
    durationInFrames: 211,
    fps: 31,
    compositionWidth: 1081,
    compositionHeight: 1351,
    inputProps,
    autoPlay: true,
    loop: false,
    moveToBeginningWhenEnded: false,
    controls: false,
    clickToPlay: false,
    doubleClickToFullscreen: false,
    spaceKeyToPlayOrPause: false,
    initiallyMuted: true,
  });
});
