import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing } from 'lucide-react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getOverrideClockParts } from '../utils/broadcastTime';
import {
  normalizeModoItalianoSongSequence,
  resolveModoItalianoSongLeaf,
  type ModoItalianoSongSequence
} from '../utils/modoItalianoSequence';

export interface ModoItalianoClockCity {
  city: string;
  timezone: string;
}

interface ModoItalianoClockProps {
  timeOverride?: GlobalTimeOverride | null;
  rotationIntervalMs?: number;
  transitionDurationMs?: number;
  shuffleCities?: boolean;
  widthPx?: number;
  language?: 'it' | 'en' | 'es';
  showWorldClocks?: boolean;
  showBellIcon?: boolean;
  songs?: unknown;
  songSequence?: unknown;
  playingSong?: boolean;
  songArtist?: string;
  songTitle?: string;
  songCoverUrl?: string;
  songEaroneSongId?: string;
  songEaroneRank?: string;
  songEaroneSpins?: string;
  inline?: boolean;
}

const DEFAULT_MODOITALIANO_CLOCK_CITIES: ModoItalianoClockCity[] = [
  { city: 'IT', timezone: 'Europe/Rome' },
  { city: 'ES', timezone: 'Europe/Madrid' },
  { city: 'UY', timezone: 'America/Montevideo' },
  { city: 'CL', timezone: 'America/Santiago' },
  { city: 'NY', timezone: 'America/New_York' }
];
const SONG_UI_FADE_MS = 320;
const SONG_BOX_MOTION_MS = 360;

interface SongPayload {
  id?: string;
  artist: string;
  title: string;
  coverUrl: string;
  audioUrl?: string;
  durationMs?: number;
  earoneSongId?: string;
  earoneRank?: string;
  earoneSpins?: string;
}

function toSingleSongSequence(song: SongPayload): ModoItalianoSongSequence {
  const itemId = `song_${Math.random().toString(36).slice(2, 8)}`;
  return {
    mode: 'manual',
    items: [
      {
        id: itemId,
        kind: 'preset',
        artist: song.artist,
        title: song.title,
        coverUrl: song.coverUrl,
        audioUrl: song.audioUrl,
        durationMs: song.durationMs,
        earoneSongId: song.earoneSongId,
        earoneRank: song.earoneRank,
        earoneSpins: song.earoneSpins
      }
    ],
    activeItemId: itemId,
    intervalMs: 4000,
    loop: true,
    startedAt: Date.now()
  };
}

function shuffleArray<T>(items: T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function formatClockValue(timezone: string, now: Date, timeOverride: GlobalTimeOverride | null): string {
  if (timeOverride) {
    const parts = getOverrideClockParts(timeOverride, now);
    if (parts) {
      return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}`;
    }
  }

  try {
    return now.toLocaleTimeString('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
}

function normalizeSongPayload(value: unknown): SongPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const coverUrl = typeof record.coverUrl === 'string' ? record.coverUrl.trim() : '';
  const audioUrl = typeof record.audioUrl === 'string' ? record.audioUrl.trim() : '';
  const durationMs =
    typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0
      ? Math.round(record.durationMs)
      : undefined;
  const earoneSongId =
    typeof record.earoneSongId === 'string' && record.earoneSongId.trim()
      ? record.earoneSongId.trim()
      : typeof record.earoneSongId === 'number' && Number.isFinite(record.earoneSongId)
        ? String(record.earoneSongId)
        : undefined;
  const earoneRank = typeof record.earoneRank === 'string' && record.earoneRank.trim() ? record.earoneRank.trim() : undefined;
  const earoneSpins =
    typeof record.earoneSpins === 'string' && record.earoneSpins.trim()
      ? record.earoneSpins.trim()
      : typeof record.earoneSpins === 'number' && Number.isFinite(record.earoneSpins)
        ? String(record.earoneSpins)
        : undefined;

  if (!artist && !title && !coverUrl && !audioUrl && !durationMs && !earoneSongId && !earoneRank && !earoneSpins) {
    return null;
  }

  return {
    artist,
    title,
    coverUrl,
    audioUrl: audioUrl || undefined,
    durationMs,
    earoneSongId,
    earoneRank,
    earoneSpins
  };
}

export const ModoItalianoClock: React.FC<ModoItalianoClockProps> = ({
  timeOverride = null,
  rotationIntervalMs = 5000,
  transitionDurationMs = 300,
  shuffleCities = false,
  widthPx = 220,
  language = 'it',
  showWorldClocks = true,
  showBellIcon = false,
  songs,
  songSequence,
  playingSong,
  songArtist = '',
  songTitle = '',
  songCoverUrl = '',
  songEaroneSongId = '',
  songEaroneRank = '',
  songEaroneSpins = '',
  inline = false
}) => {
  const resolvedCities = DEFAULT_MODOITALIANO_CLOCK_CITIES;
  const [now, setNow] = useState(() => new Date());
  const [cityPool, setCityPool] = useState<ModoItalianoClockCity[]>(() => (shuffleCities ? shuffleArray(resolvedCities) : [...resolvedCities]));
  const [cityIndex, setCityIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCityPool(shuffleCities ? shuffleArray(resolvedCities) : [...resolvedCities]);
    setCityIndex(0);
    setIsFading(false);
  }, [resolvedCities, shuffleCities]);

  useEffect(() => {
    if (!showWorldClocks || cityPool.length <= 1) {
      return;
    }

    const rotateDelay = Math.max(500, rotationIntervalMs);
    const fadeDuration = Math.max(0, transitionDurationMs);
    let switchTimer: number | undefined;

    const interval = window.setInterval(() => {
      setIsFading(true);
      switchTimer = window.setTimeout(() => {
        setCityIndex((prevIndex) => {
          const nextIndex = prevIndex + 1;
          if (nextIndex >= cityPool.length) {
            setCityPool((prevPool) => (shuffleCities ? shuffleArray(prevPool) : prevPool));
            return 0;
          }
          return nextIndex;
        });
        setIsFading(false);
      }, fadeDuration);
    }, rotateDelay);

    return () => {
      window.clearInterval(interval);
      if (switchTimer !== undefined) {
        window.clearTimeout(switchTimer);
      }
    };
  }, [showWorldClocks, cityPool, rotationIntervalMs, transitionDurationMs, shuffleCities]);

  const currentCity = cityPool[cityIndex] ?? resolvedCities[0];
  const timeText = formatClockValue(currentCity.timezone, now, timeOverride);
  const normalizedSongSequence = useMemo(() => normalizeModoItalianoSongSequence(songSequence), [songSequence]);
  const [sequenceNowMs, setSequenceNowMs] = useState(() => Date.now());
  const legacySongPayload = useMemo(() => {
    const directFromFields = normalizeSongPayload({
      artist: songArtist,
      title: songTitle,
      coverUrl: songCoverUrl,
      earoneSongId: songEaroneSongId,
      earoneRank: songEaroneRank,
      earoneSpins: songEaroneSpins
    });
    if (directFromFields) {
      return directFromFields;
    }

    if (!Array.isArray(songs)) {
      return null;
    }

    for (const song of songs) {
      const normalized = normalizeSongPayload(song);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }, [songArtist, songTitle, songCoverUrl, songEaroneSongId, songEaroneRank, songEaroneSpins, songs]);
  const effectiveSongSequence = useMemo(
    () => normalizedSongSequence ?? (legacySongPayload ? toSingleSongSequence(legacySongPayload) : null),
    [normalizedSongSequence, legacySongPayload]
  );
  const resolvedSequenceSong = useMemo(
    () =>
      resolveModoItalianoSongLeaf(
        {
          sequence: effectiveSongSequence
        },
        sequenceNowMs
      ),
    [sequenceNowMs, effectiveSongSequence]
  );

  useEffect(() => {
    setSequenceNowMs(Date.now());
  }, [effectiveSongSequence]);

  useEffect(() => {
    if (!effectiveSongSequence || effectiveSongSequence.mode !== 'autoplay') {
      return;
    }

    const timer = window.setInterval(() => {
      setSequenceNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(timer);
  }, [
    effectiveSongSequence?.mode,
    effectiveSongSequence?.startedAt,
    effectiveSongSequence?.intervalMs,
    effectiveSongSequence?.loop,
    effectiveSongSequence?.items.length
  ]);

  const activeSongPayload = resolvedSequenceSong;
  const activeSongAudioUrl = activeSongPayload?.audioUrl?.trim() || '';
  const playbackToken = activeSongAudioUrl
    ? `${activeSongPayload?.id ?? ''}:${effectiveSongSequence?.startedAt ?? ''}:${activeSongAudioUrl}`
    : '';
  const normalizedSongArtist = activeSongPayload?.artist?.trim() || '';
  const normalizedSongTitle = activeSongPayload?.title?.trim() || '';
  const normalizedSongCoverUrl = activeSongPayload?.coverUrl?.trim() || '';
  const songGateEnabled = typeof playingSong === 'boolean' ? playingSong : true;
  const hasSongPayload = songGateEnabled && (!!normalizedSongArtist || !!normalizedSongTitle);
  const [endedPlaybackToken, setEndedPlaybackToken] = useState('');
  const hasLiveSongPayload = hasSongPayload && (!playbackToken || endedPlaybackToken !== playbackToken);
  const [songUiVisible, setSongUiVisible] = useState(hasLiveSongPayload);
  const [songUiActive, setSongUiActive] = useState(hasLiveSongPayload);
  const [displaySongTitle, setDisplaySongTitle] = useState(normalizedSongTitle);
  const [displaySongArtist, setDisplaySongArtist] = useState(normalizedSongArtist);
  const [displaySongCoverUrl, setDisplaySongCoverUrl] = useState(normalizedSongCoverUrl || '/cover.jpg');
  const [clockBoxMotion, setClockBoxMotion] = useState<'in' | 'out' | null>(null);
  const previousHasSongPayloadRef = useRef(hasLiveSongPayload);
  const activeSongAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeSongPlaybackTokenRef = useRef('');
  const useSplitSongClockLayout = songUiVisible && showWorldClocks;

  useEffect(() => {
    return () => {
      if (activeSongAudioRef.current) {
        activeSongAudioRef.current.pause();
        try {
          activeSongAudioRef.current.currentTime = 0;
        } catch {
          // no-op
        }
        activeSongAudioRef.current.onended = null;
        activeSongAudioRef.current.onerror = null;
        activeSongAudioRef.current = null;
      }
      activeSongPlaybackTokenRef.current = '';
    };
  }, []);

  useEffect(() => {
    if (!songGateEnabled || !activeSongAudioUrl) {
      if (activeSongAudioRef.current) {
        activeSongAudioRef.current.pause();
        try {
          activeSongAudioRef.current.currentTime = 0;
        } catch {
          // no-op
        }
        activeSongAudioRef.current.onended = null;
        activeSongAudioRef.current.onerror = null;
        activeSongAudioRef.current = null;
      }
      activeSongPlaybackTokenRef.current = '';
      setEndedPlaybackToken('');
      return;
    }

    if (playbackToken && playbackToken === activeSongPlaybackTokenRef.current) {
      return;
    }

    if (activeSongAudioRef.current) {
      activeSongAudioRef.current.pause();
      try {
        activeSongAudioRef.current.currentTime = 0;
      } catch {
        // no-op
      }
      activeSongAudioRef.current.onended = null;
      activeSongAudioRef.current.onerror = null;
      activeSongAudioRef.current = null;
    }

    const audio = new Audio(activeSongAudioUrl);
    audio.preload = 'auto';
    activeSongAudioRef.current = audio;
    activeSongPlaybackTokenRef.current = playbackToken;
    setEndedPlaybackToken('');

    const cleanup = () => {
      if (activeSongAudioRef.current === audio) {
        activeSongAudioRef.current = null;
      }
      audio.onended = null;
      audio.onerror = null;
    };

    audio.onended = () => {
      setEndedPlaybackToken(playbackToken);
      cleanup();
    };
    audio.onerror = () => {
      console.error(`Failed to play song audio: ${activeSongAudioUrl}`);
      cleanup();
    };

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        console.error(`Failed to start song audio "${activeSongAudioUrl}"`, err);
        cleanup();
      });
    }
  }, [songGateEnabled, activeSongAudioUrl, playbackToken]);

  useEffect(() => {
    if (hasLiveSongPayload) {
      setDisplaySongTitle(normalizedSongTitle);
      setDisplaySongArtist(normalizedSongArtist);
      setDisplaySongCoverUrl(normalizedSongCoverUrl || '/cover.jpg');
    }
  }, [hasLiveSongPayload, normalizedSongTitle, normalizedSongArtist, normalizedSongCoverUrl]);

  useEffect(() => {
    const previousHasSongPayload = previousHasSongPayloadRef.current;
    previousHasSongPayloadRef.current = hasLiveSongPayload;

    let fadeTimer: number | undefined;
    let motionTimer: number | undefined;
    let frameHandle: number | undefined;

    if (hasLiveSongPayload) {
      setSongUiVisible(true);
      frameHandle = window.requestAnimationFrame(() => {
        setSongUiActive(true);
      });

      if (!previousHasSongPayload) {
        setClockBoxMotion('in');
        motionTimer = window.setTimeout(() => {
          setClockBoxMotion(null);
        }, SONG_BOX_MOTION_MS);
      }
    } else if (previousHasSongPayload) {
      setSongUiActive(false);
      setClockBoxMotion('out');
      fadeTimer = window.setTimeout(() => {
        setSongUiVisible(false);
        setDisplaySongTitle('');
        setDisplaySongArtist('');
        setDisplaySongCoverUrl('/cover.jpg');
      }, SONG_UI_FADE_MS);
      motionTimer = window.setTimeout(() => {
        setClockBoxMotion(null);
      }, SONG_BOX_MOTION_MS);
    }

    return () => {
      if (frameHandle !== undefined) {
        window.cancelAnimationFrame(frameHandle);
      }
      if (fadeTimer !== undefined) {
        window.clearTimeout(fadeTimer);
      }
      if (motionTimer !== undefined) {
        window.clearTimeout(motionTimer);
      }
    };
  }, [hasLiveSongPayload]);

  if (!showWorldClocks && !showBellIcon) {
    return null;
  }
  const wrapperStyle: React.CSSProperties = inline
    ? {
        display: 'flex',
        flexDirection: 'column',
        width: useSplitSongClockLayout ? '100%' : 'fit-content'
      }
    : {
        position: 'absolute',
        top: '64px',
        right: '96px',
        zIndex: 950,
        display: 'flex',
        flexDirection: 'column',
        width: useSplitSongClockLayout ? 'min(1420px, calc(100vw - 192px))' : 'fit-content'
    };
  const listeningStyle: React.CSSProperties = {
    color: '#ffffff',
    fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
    fontSize: '38.4px',
    fontWeight: 500,
    lineHeight: 1,
    textAlign: 'left',
    textShadow: '0 4px 18px rgba(0, 0, 0, 0.96), 0 0 28px rgba(0, 0, 0, 0.72), 0 0 10px rgba(255, 255, 255, 0.2)',
    WebkitTextStroke: '0.7px rgba(0, 0, 0, 0.5)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    paddingLeft: '34px'
  };
  const listeningRowStyle: React.CSSProperties = {
    marginBottom: '18px',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '16px',
    paddingRight: '34px',
    opacity: songUiActive ? 1 : 0,
    transform: songUiActive ? 'translateY(0px)' : 'translateY(10px)',
    transition: `opacity ${SONG_UI_FADE_MS}ms ease, transform ${SONG_UI_FADE_MS}ms ease`
  };
  const coverStyle: React.CSSProperties = {
    width: '198px',
    height: '198px',
    borderRadius: '12px',
    objectFit: 'cover',
    boxShadow: '0 10px 24px rgba(0, 0, 0, 0.55)',
    flexShrink: 0
  };
  const hasSongCardBackground = songUiVisible;
  const clockBoxMotionAnimation =
    clockBoxMotion === 'in'
      ? `, modoItalianoClockSongBoxIn ${SONG_BOX_MOTION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) 1`
      : clockBoxMotion === 'out'
        ? `, modoItalianoClockSongBoxOut ${SONG_BOX_MOTION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) 1`
        : '';
  const outerStyle: React.CSSProperties = {
    height: '140px',
    borderRadius: '50px',
    background: hasSongCardBackground ? 'linear-gradient(125deg, #6B7E39 0%, #3F4D20 48%, #6B7E39 100%)' : 'transparent',
    backgroundSize: hasSongCardBackground ? '200% 200%' : undefined,
    display: 'flex',
    alignItems: 'center',
    justifyContent: useSplitSongClockLayout ? 'space-between' : 'flex-start',
    width: useSplitSongClockLayout ? '100%' : undefined,
    padding: '0 34px',
    boxShadow: hasSongCardBackground ? '0 24px 44px rgba(0, 0, 0, 0.72)' : 'none',
    filter: hasSongCardBackground ? 'drop-shadow(0 12px 24px rgba(0, 0, 0, 0.52))' : 'none',
    maxWidth: '100%',
    transformOrigin: 'right center',
    animation: hasSongCardBackground
      ? `modoItalianoClockBgFlow 8s ease-in-out infinite, modoItalianoClockBgPalette 60s ease-in-out infinite${clockBoxMotionAnimation}`
      : clockBoxMotion
        ? `modoItalianoClockSongBox${clockBoxMotion === 'in' ? 'In' : 'Out'} ${SONG_BOX_MOTION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) 1`
        : undefined
  };

  const cityLabel = currentCity.city.trim().toUpperCase();
  const clockBadgeText = `${timeText} ${cityLabel}`.trim();
  const cityClockBlock = (
    <div
      style={{
        minWidth: `${Math.max(160, widthPx)}px`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px'
      }}
    >
      <div
        aria-label='MI'
        role='img'
        style={{
          width: '172px',
          height: '56px',
          background: 'rgba(255, 255, 255, 0.56)',
          WebkitMaskImage: "url('/mi.svg')",
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          WebkitMaskSize: 'contain',
          maskImage: "url('/mi.svg')",
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
          maskSize: 'contain'
        }}
      />
      <div
        style={{
          height: '62px',
          minWidth: `${Math.max(176, widthPx)}px`,
          borderRadius: '999px',
          background: 'rgba(255, 255, 255, 0.56)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px'
        }}
      >
        <span
          style={{
            color: '#1f1f1f',
            fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
            fontSize: '38.4px',
            fontWeight: 600,
            lineHeight: 1,
            textAlign: 'center',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            opacity: isFading ? 0.35 : 1,
            transition: 'opacity 220ms ease'
          }}
        >
          {clockBadgeText}
        </span>
      </div>
    </div>
  );

  return (
    <div style={wrapperStyle}>
      <style>{`
        @keyframes modoItalianoClockBgFlow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes modoItalianoClockBgPalette {
          0% {
            background-image: linear-gradient(125deg, #6B7E39 0%, #3F4D20 48%, #6B7E39 100%);
          }
          50% {
            background-image: linear-gradient(125deg, #A42323 0%, #661313 48%, #A42323 100%);
          }
          100% {
            background-image: linear-gradient(125deg, #6B7E39 0%, #3F4D20 48%, #6B7E39 100%);
          }
        }
        @keyframes modoItalianoClockSongBoxIn {
          0% { transform: scale(1); }
          60% { transform: scale(1.04); }
          100% { transform: scale(1); }
        }
        @keyframes modoItalianoClockSongBoxOut {
          0% { transform: scale(1); }
          60% { transform: scale(0.96); }
          100% { transform: scale(1); }
        }
      `}</style>
      {songUiVisible && (
        <div style={listeningRowStyle}>
          <div style={listeningStyle}>Estás escuchando:</div>
          <img src={displaySongCoverUrl} alt='Cover' style={coverStyle} />
        </div>
      )}
      <div style={outerStyle}>
        {songUiVisible && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              marginRight: '28px',
              flex: useSplitSongClockLayout ? '1 1 auto' : undefined,
              minWidth: useSplitSongClockLayout ? 0 : undefined,
              maxWidth: useSplitSongClockLayout ? undefined : '980px',
              opacity: songUiActive ? 1 : 0,
              transform: songUiActive ? 'translateY(0px)' : 'translateY(10px)',
              transition: `opacity ${SONG_UI_FADE_MS}ms ease, transform ${SONG_UI_FADE_MS}ms ease`
            }}
          >
            {displaySongTitle ? (
              <div
                style={{
                  color: '#ffffff',
                  fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
                  fontSize: '44px',
                  fontWeight: 600,
                  lineHeight: 1,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {displaySongTitle}
              </div>
            ) : null}
            {displaySongArtist ? (
              <div
                style={{
                  marginTop: displaySongTitle ? '8px' : 0,
                  color: '#ffffff',
                  fontFamily: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
                  fontSize: '44px',
                  fontWeight: 500,
                  lineHeight: 1,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {displaySongArtist}
              </div>
            ) : null}
          </div>
        )}
        {(showWorldClocks || showBellIcon) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
              marginLeft: useSplitSongClockLayout ? '24px' : 0
            }}
          >
            {showWorldClocks && cityClockBlock}
            {showBellIcon && (
              <div
                style={{
                  marginLeft: showWorldClocks ? '20px' : 0,
                  width: '72px',
                  height: '72px',
                  borderRadius: '24px',
                  background: '#3a3a3a',
                  color: '#f3f3f3',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <BellRing size={42} strokeWidth={2} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
