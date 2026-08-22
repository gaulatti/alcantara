import React, { useEffect, useMemo, useState } from 'react';
import { BellRing } from 'lucide-react';
import type { GlobalTimeOverride } from '../utils/broadcastTime';
import { getOverrideClockParts } from '../utils/broadcastTime';
import { normalizeProgramSongSequence, resolveProgramSongLeaf, type ProgramSongSequence } from '../utils/programSequence';
import { getProgramAudioBusSnapshot, subscribeProgramAudioBus } from '../utils/programAudioBus';

export interface ModoItalianoGiorgiaClockCity {
  city: string;
  timezone: string;
}

interface ModoItalianoGiorgiaClockProps {
  programId: string;
  timeOverride?: GlobalTimeOverride | null;
  rotationIntervalMs?: number;
  transitionDurationMs?: number;
  shuffleCities?: boolean;
  widthPx?: number;
  language?: 'it' | 'en' | 'es';
  showWorldClocks?: boolean;
  showBellIcon?: boolean;
  showLogo?: boolean;
  showPlaybackProgress?: boolean;
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

const SIGNAL = '#ed0076';
const CITIES: ModoItalianoGiorgiaClockCity[] = [
  { city: 'IT', timezone: 'Europe/Rome' },
  { city: 'ES', timezone: 'Europe/Madrid' },
  { city: 'UY', timezone: 'America/Montevideo' },
  { city: 'CL', timezone: 'America/Santiago' },
  { city: 'NY', timezone: 'America/New_York' }
];

interface SongPayload {
  id?: string;
  artist: string;
  title: string;
  coverUrl: string;
  audioUrl?: string;
  durationMs?: number;
}

function shuffleArray<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function formatClockValue(timezone: string, now: Date, timeOverride: GlobalTimeOverride | null): string {
  if (timeOverride) {
    const parts = getOverrideClockParts(timeOverride, now);
    if (parts) return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}`;
  }

  try {
    return now.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

function normalizeSongPayload(value: unknown): SongPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const artist = typeof record.artist === 'string' ? record.artist.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const coverUrl = typeof record.coverUrl === 'string' ? record.coverUrl.trim() : '';
  const audioUrl = typeof record.audioUrl === 'string' ? record.audioUrl.trim() : '';
  const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : undefined;
  if (!artist && !title && !coverUrl && !audioUrl) return null;
  return { artist, title, coverUrl, audioUrl: audioUrl || undefined, durationMs };
}

function toSingleSongSequence(song: SongPayload): ProgramSongSequence {
  const id = [song.id, song.artist, song.title, song.audioUrl, song.coverUrl].filter(Boolean).join('|');
  return {
    mode: 'manual',
    items: [{ id, kind: 'preset', artist: song.artist, title: song.title, coverUrl: song.coverUrl, audioUrl: song.audioUrl, durationMs: song.durationMs }],
    activeItemId: id,
    intervalMs: 4000,
    loop: true,
    startedAt: 0
  };
}

export const ModoItalianoGiorgiaClock: React.FC<ModoItalianoGiorgiaClockProps> = ({
  programId,
  timeOverride = null,
  rotationIntervalMs = 5000,
  transitionDurationMs = 300,
  shuffleCities = false,
  widthPx = 220,
  language = 'es',
  showWorldClocks = true,
  showBellIcon = false,
  showLogo = true,
  showPlaybackProgress = true,
  songs,
  songSequence,
  playingSong,
  songArtist = '',
  songTitle = '',
  songCoverUrl = '',
  inline = false
}) => {
  const [now, setNow] = useState(() => new Date());
  const [cityPool, setCityPool] = useState(() => (shuffleCities ? shuffleArray(CITIES) : [...CITIES]));
  const [cityIndex, setCityIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);
  const [sequenceNowMs, setSequenceNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCityPool(shuffleCities ? shuffleArray(CITIES) : [...CITIES]);
    setCityIndex(0);
    setIsFading(false);
  }, [shuffleCities]);

  useEffect(() => {
    if (!showWorldClocks || cityPool.length <= 1) return;
    let switchTimer: number | undefined;
    const timer = window.setInterval(() => {
      setIsFading(true);
      switchTimer = window.setTimeout(() => {
        setCityIndex((current) => {
          const next = current + 1;
          if (next < cityPool.length) return next;
          setCityPool((pool) => (shuffleCities ? shuffleArray(pool) : pool));
          return 0;
        });
        setIsFading(false);
      }, Math.max(0, transitionDurationMs));
    }, Math.max(500, rotationIntervalMs));
    return () => {
      window.clearInterval(timer);
      if (switchTimer !== undefined) window.clearTimeout(switchTimer);
    };
  }, [showWorldClocks, cityPool, rotationIntervalMs, transitionDurationMs, shuffleCities]);

  const normalizedSequence = useMemo(() => normalizeProgramSongSequence(songSequence), [songSequence]);
  const legacySong = useMemo(() => {
    const direct = normalizeSongPayload({ artist: songArtist, title: songTitle, coverUrl: songCoverUrl });
    if (direct) return direct;
    if (!Array.isArray(songs)) return null;
    for (const song of songs) {
      const normalized = normalizeSongPayload(song);
      if (normalized) return normalized;
    }
    return null;
  }, [songArtist, songTitle, songCoverUrl, songs]);
  const effectiveSequence = useMemo(
    () => normalizedSequence ?? (legacySong ? toSingleSongSequence(legacySong) : null),
    [normalizedSequence, legacySong]
  );
  const resolvedSong = useMemo(
    () => resolveProgramSongLeaf({ sequence: effectiveSequence }, sequenceNowMs),
    [effectiveSequence, sequenceNowMs]
  );

  useEffect(() => setSequenceNowMs(Date.now()), [effectiveSequence]);
  useEffect(() => {
    if (!effectiveSequence || effectiveSequence.mode !== 'autoplay') return;
    const timer = window.setInterval(() => setSequenceNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [effectiveSequence]);

  const [audioBus, setAudioBus] = useState(() => getProgramAudioBusSnapshot(programId));
  useEffect(() => subscribeProgramAudioBus(programId, setAudioBus), [programId]);

  const songGateEnabled = typeof playingSong === 'boolean' ? playingSong : true;
  const liveSong = songGateEnabled ? audioBus.track : null;
  const artist = (liveSong?.artist ?? resolvedSong?.artist ?? '').trim();
  const title = (liveSong?.title ?? resolvedSong?.title ?? '').trim();
  const coverUrl = (liveSong?.coverUrl ?? resolvedSong?.coverUrl ?? songCoverUrl).trim();
  const hasSong = songGateEnabled && Boolean(artist || title) && (!liveSong || audioBus.endedToken !== liveSong.token);
  const progress = Math.max(0, Math.min(1, liveSong ? audioBus.progress : 0));
  const city = cityPool[cityIndex] ?? CITIES[0];
  const timeText = formatClockValue(city.timezone, now, timeOverride);
  const listeningLabel = language === 'it' ? 'Stai ascoltando' : language === 'en' ? 'Now playing' : 'Estás escuchando';

  if (!showWorldClocks && !showBellIcon && !showLogo) return null;

  const logoBlock = (
    <div
      aria-label='MI'
      role='img'
      style={{
        width: '172px',
        height: '56px',
        background: 'rgba(255,255,255,0.94)',
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
  );
  const useSplitLayout = hasSong && (showWorldClocks || showLogo || showBellIcon);
  const wrapperStyle: React.CSSProperties = inline
    ? { display: 'flex', flexDirection: 'column', width: useSplitLayout ? '100%' : 'fit-content' }
    : {
        position: 'absolute',
        top: '64px',
        right: '96px',
        zIndex: 950,
        display: 'flex',
        flexDirection: 'column',
        width: useSplitLayout ? 'min(1420px, calc(100vw - 192px))' : 'fit-content'
      };
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
      {showLogo ? logoBlock : null}
      <div
        style={{
          height: '62px',
          minWidth: `${Math.max(176, widthPx)}px`,
          borderRadius: '999px',
          background: SIGNAL,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px',
          boxShadow: '0 8px 24px rgba(237,0,118,0.28)'
        }}
      >
        <span
          style={{
            color: '#ffffff',
            fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
            fontSize: '38.4px',
            fontWeight: 600,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            opacity: isFading ? 0.35 : 1,
            transition: `opacity ${Math.max(120, transitionDurationMs)}ms ease`
          }}
        >
          {timeText} {city.city.toUpperCase()}
        </span>
      </div>
    </div>
  );

  return (
    <div className='modoitaliano-giorgia-clock' style={wrapperStyle} aria-label='Modo Italiano Giorgia clock'>
      <style>{`
        @keyframes modoItalianoGiorgiaClockBgFlow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .modoitaliano-giorgia-clock,
          .modoitaliano-giorgia-clock * { transition-duration: 0.01ms !important; animation: none !important; }
        }
      `}</style>
      {hasSong ? (
        <div
          style={{
            marginBottom: '18px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '0 34px'
          }}
        >
          <div
            style={{
              color: SIGNAL,
              fontFamily: "'Outfit', 'Encode Sans', system-ui, sans-serif",
              fontSize: '38.4px',
              fontWeight: 500,
              lineHeight: 1,
              textShadow: '0 4px 18px rgba(0,0,0,0.96)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {listeningLabel}:
          </div>
          <img
            src={coverUrl || '/cover.jpg'}
            alt='Cover'
            style={{ width: '198px', height: '198px', borderRadius: '12px', objectFit: 'cover', boxShadow: '0 10px 24px rgba(0,0,0,0.55)', flexShrink: 0 }}
          />
        </div>
      ) : null}
      <div
        style={{
          position: 'relative',
          height: '140px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: useSplitLayout ? 'space-between' : 'flex-start',
          width: useSplitLayout ? '100%' : undefined,
          maxWidth: '100%',
          padding: '0 34px',
          overflow: 'hidden',
          borderRadius: '50px',
          background: hasSong ? 'linear-gradient(125deg, #080d2a 0%, #111c50 48%, #080d2a 100%)' : 'transparent',
          backgroundSize: hasSong ? '200% 200%' : undefined,
          animation: hasSong ? 'modoItalianoGiorgiaClockBgFlow 8s ease-in-out infinite' : undefined,
          boxShadow: hasSong ? `inset 0 0 0 2px rgba(237,0,118,0.62), 0 24px 44px rgba(0,0,0,0.72)` : 'none',
          filter: hasSong ? 'drop-shadow(0 12px 24px rgba(0,0,0,0.52))' : 'none'
        }}
      >
        {hasSong ? (
          <div
            style={{
              minWidth: 0,
              flex: useSplitLayout ? '1 1 auto' : undefined,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              marginRight: '28px'
            }}
          >
            {title ? (
              <div
                style={{
                  color: '#ffffff',
                  fontFamily: "'Barlow Condensed', system-ui, sans-serif",
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
                {title}
              </div>
            ) : null}
            {artist ? (
              <div
                style={{
                  marginTop: title ? '8px' : 0,
                  color: 'rgba(255,255,255,0.82)',
                  fontFamily: "'Barlow Condensed', system-ui, sans-serif",
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
                {artist}
              </div>
            ) : null}
          </div>
        ) : null}
        {(showWorldClocks || showLogo || showBellIcon) ? (
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: useSplitLayout ? '24px' : 0, gap: '20px' }}>
            {showWorldClocks ? cityClockBlock : showLogo ? logoBlock : null}
            {showBellIcon ? (
              <div style={{ width: '72px', height: '72px', borderRadius: '24px', background: '#111c50', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <BellRing size={42} strokeWidth={2} />
              </div>
            ) : null}
          </div>
        ) : null}
        {hasSong && showPlaybackProgress ? (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', overflow: 'hidden', pointerEvents: 'none' }}>
            <div
              style={{
                width: '100%',
                height: '100%',
                background: 'linear-gradient(90deg, rgba(237,0,118,0.2), rgba(237,0,118,0.05))',
                transform: `scaleX(${progress})`,
                transformOrigin: 'left center',
                transition: 'transform 140ms linear'
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
