import React, { useEffect, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
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
  masterGain: number;
}

/**
 * Plays Giorgia's own artist bumper composition. Nothing about the bumper is
 * defined here: the timeline, layout and type all come from
 * `@modoitaliano/giorgia/video`, played the way Giorgia's Storybook plays it.
 */
export default function ModoItalianoGiorgiaArtistBumperPlayer({ inputProps, masterGain }: ArtistBumperPlayerProps) {
  const playerRef = useRef<PlayerRef>(null);
  const gain = Number.isFinite(masterGain) ? Math.max(0, Math.min(1, masterGain)) : 0;

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setVolume(gain);
    if (gain <= 0.0001) player.mute();
    else player.unmute();
  }, [gain]);

  return (
    <Player
      ref={playerRef}
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
      initiallyMuted={gain <= 0.0001}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
