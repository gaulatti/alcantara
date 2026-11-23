import React from 'react';
import { Player } from '@remotion/player';
import {
  ARTIST_BUMPER_DURATION_IN_FRAMES,
  ARTIST_BUMPER_FPS,
  ARTIST_BUMPER_HEIGHT,
  ARTIST_BUMPER_WIDTH,
  ArtistBumper,
  type ArtistBumperProps
} from '@modoitaliano/giorgia/video';

interface ArtistBumperPlayerProps {
  inputProps: ArtistBumperProps;
}

/**
 * Plays Giorgia's own artist bumper composition. Nothing about the bumper is
 * defined here: the timeline, layout and type all come from
 * `@modoitaliano/giorgia/video`, played the way Giorgia's Storybook plays it.
 */
export default function ModoItalianoGiorgiaArtistBumperPlayer({ inputProps }: ArtistBumperPlayerProps) {
  return (
    <Player
      component={ArtistBumper}
      inputProps={inputProps}
      acknowledgeRemotionLicense
      durationInFrames={ARTIST_BUMPER_DURATION_IN_FRAMES}
      fps={ARTIST_BUMPER_FPS}
      compositionWidth={ARTIST_BUMPER_WIDTH}
      compositionHeight={ARTIST_BUMPER_HEIGHT}
      autoPlay
      loop={false}
      // Hold the final "In onda ora" card instead of jumping back to the first image.
      moveToBeginningWhenEnded={false}
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      // The bumper carries no audio; muted also lets it autoplay in any browser.
      initiallyMuted
      style={{ width: '100%', height: '100%' }}
    />
  );
}
