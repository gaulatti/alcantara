import React, { useEffect, useMemo, useState } from 'react';
import { BellRing } from 'lucide-react';
import { GIORGIA, GiorgiaGrade, GiorgiaMark, GiorgiaRule, fitGiorgiaText, giorgiaLabelStyle, useElementHeight } from './giorgiaBroadcast';
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
  /**
   * Which piece to render. The header (mark and time) sits top-left and the
   * on-air block bottom-left; a scene row places the two separately.
   */
  part?: 'all' | 'header' | 'onAir';
  /** For scenes shot over a chroma key: solid navy plates, no soft edges. See `GiorgiaGrade`. */
  keySafe?: boolean;
}

const ON_AIR_TEXT_WIDTH_PX = 560;
const COVER_PX = 168;
const ON_AIR_TRANSITION_MS = 450;
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
  shuffleCities = false,
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
  inline = false,
  part = 'all',
  keySafe = false
}) => {
  const [now, setNow] = useState(() => new Date());
  const [cityPool, setCityPool] = useState(() => (shuffleCities ? shuffleArray(CITIES) : [...CITIES]));
  const [cityIndex, setCityIndex] = useState(0);
  const [sequenceNowMs, setSequenceNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCityPool(shuffleCities ? shuffleArray(CITIES) : [...CITIES]);
    setCityIndex(0);
  }, [shuffleCities]);

  useEffect(() => {
    if (!showWorldClocks || cityPool.length <= 1) return;
    // The city changes with a hard cut, like every other Giorgia transition.
    const timer = window.setInterval(() => {
      setCityIndex((current) => {
        const next = current + 1;
        if (next < cityPool.length) return next;
        setCityPool((pool) => (shuffleCities ? shuffleArray(pool) : pool));
        return 0;
      });
    }, Math.max(500, rotationIntervalMs));
    return () => window.clearInterval(timer);
  }, [showWorldClocks, cityPool, rotationIntervalMs, shuffleCities]);

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

  const [textColumnRef, textColumnHeight] = useElementHeight<HTMLDivElement>();
  const coverSize = Math.max(COVER_PX, textColumnHeight);
  // The on-air block eases in and out instead of cutting: while it leaves, it keeps showing the song that just ended.
  const [shownSong, setShownSong] = useState({ artist, title, coverUrl });
  const [onAirMounted, setOnAirMounted] = useState(hasSong);
  const [onAirVisible, setOnAirVisible] = useState(hasSong);
  useEffect(() => {
    if (hasSong) setShownSong({ artist, title, coverUrl });
  }, [hasSong, artist, title, coverUrl]);
  useEffect(() => {
    if (hasSong) {
      setOnAirMounted(true);
      const frame = window.requestAnimationFrame(() => setOnAirVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setOnAirVisible(false);
    const timer = window.setTimeout(() => setOnAirMounted(false), ON_AIR_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [hasSong]);
  const city = cityPool[cityIndex] ?? CITIES[0];
  const timeText = formatClockValue(city.timezone, now, timeOverride);
  const listeningLabel = language === 'it' ? 'In onda ora' : language === 'en' ? 'On air now' : 'Estás escuchando';

  if (!showWorldClocks && !showBellIcon && !showLogo) return null;

  // Key-safe, type carries no shadow: a soft shadow is partly transparent and keys as a dirty edge.
  const noShadow = keySafe ? { textShadow: 'none' } : null;

  const header =
    part === 'onAir' ? null : (
      <div
        className='modoitaliano-giorgia-clock-header'
        aria-label='Modo Italiano Giorgia clock'
        style={{
          position: 'absolute',
          top: `${GIORGIA.safeTop}px`,
          left: `${GIORGIA.safeX}px`,
          zIndex: 950,
          display: 'flex',
          alignItems: 'center',
          gap: '30px',
          // Key-safe, the header sits on its own navy plate that runs off the top-left corner, so the mark
          // and the time never touch the key colour. The margin keeps them where they are without it.
          ...(keySafe
            ? {
                background: GIORGIA.plate,
                padding: `${GIORGIA.safeTop}px ${GIORGIA.platePadding}px ${GIORGIA.platePadding}px ${GIORGIA.safeX}px`,
                margin: `-${GIORGIA.safeTop}px 0 0 -${GIORGIA.safeX}px`
              }
            : null)
        }}
      >
        {showLogo ? <GiorgiaMark keySafe={keySafe} /> : null}
        {showWorldClocks ? (
          <span style={{ ...giorgiaLabelStyle, color: 'rgba(255,255,255,0.86)', fontVariantNumeric: 'tabular-nums', ...noShadow }}>
            {timeText} {city.city.toUpperCase()}
          </span>
        ) : null}
        {showBellIcon ? <BellRing size={34} strokeWidth={2.4} color='#ffffff' /> : null}
      </div>
    );

  const artistText = shownSong.artist.toUpperCase();
  const titleText = shownSong.title.toUpperCase();
  // Without an artist the title leads, so the block always has one hero line.
  const heroText = artistText || titleText;
  const supportText = artistText ? titleText : '';
  const heroSize = fitGiorgiaText(heroText, ON_AIR_TEXT_WIDTH_PX, 104, 54, 0.5);
  const heroWraps = heroText.length * 0.5 * 54 > ON_AIR_TEXT_WIDTH_PX;
  const supportSize = fitGiorgiaText(supportText, ON_AIR_TEXT_WIDTH_PX, 32, 20, 0.78);
  const supportWraps = supportText.length * 0.78 * 20 > ON_AIR_TEXT_WIDTH_PX;

  const onAir =
    part === 'header' || !onAirMounted ? null : (
      <div
        className='modoitaliano-giorgia-clock-on-air'
        aria-label='Modo Italiano Giorgia now playing'
        style={{
          // No opacity or transform here: either would trap the grade in this block's own layer, where it
          // would paint over the headline beside it. The content wrapper below carries the motion.
          ...(inline
            ? { position: 'relative' }
            : { position: 'absolute', left: `${GIORGIA.safeX}px`, bottom: `${GIORGIA.safeBottom}px`, zIndex: 950 })
        }}
      >
        <GiorgiaGrade keySafe={keySafe} style={{ opacity: onAirVisible ? 1 : 0, transition: `opacity ${ON_AIR_TRANSITION_MS}ms ease` }} />
        <div
          className='modoitaliano-giorgia-clock-on-air-content'
          style={{
            display: 'flex',
            // Not stretched: the text column keeps its own height, which is what the cover is sized from.
            alignItems: 'flex-end',
            opacity: onAirVisible ? 1 : 0,
            transform: onAirVisible ? 'translateY(0px)' : 'translateY(18px)',
            transition: `opacity ${ON_AIR_TRANSITION_MS}ms ease, transform ${ON_AIR_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
          }}
        >
        <img
          src={shownSong.coverUrl || '/cover.jpg'}
          alt=''
          // The cover is a square exactly as tall as the text beside it, so it and the magenta rule always
          // start and end together. A fixed size left the rule standing taller than the cover whenever the
          // text was taller.
          style={{ width: `${coverSize}px`, height: `${coverSize}px`, objectFit: 'cover', display: 'block', flexShrink: 0 }}
        />
        <div
          ref={textColumnRef}
          style={{
            position: 'relative',
            width: `${ON_AIR_TEXT_WIDTH_PX + GIORGIA.ruleWidth + 28}px`,
            paddingLeft: `${GIORGIA.ruleWidth + 28}px`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            minHeight: `${COVER_PX}px`,
            color: '#ffffff'
          }}
        >
          <GiorgiaRule keySafe={keySafe} />
          <div style={{ ...giorgiaLabelStyle, color: GIORGIA.signal, ...noShadow }}>{listeningLabel}</div>
          <div
            className='modoitaliano-giorgia-clock-hero'
            style={{
              marginTop: '14px',
              fontFamily: GIORGIA.display,
              fontSize: `${heroWraps ? 54 : heroSize}px`,
              fontWeight: 800,
              lineHeight: 0.86,
              letterSpacing: '-0.035em',
              textShadow: keySafe ? 'none' : GIORGIA.displayShadow,
              // Too long for one line at the smallest size: wrap, never clamp or clip.
              ...(heroWraps ? { textWrap: 'balance', overflowWrap: 'anywhere' } : { whiteSpace: 'nowrap' })
            }}
          >
            {heroText}
          </div>
          {supportText ? (
            <div
              style={{
                marginTop: '14px',
                fontFamily: GIORGIA.text,
                fontSize: `${supportSize}px`,
                fontWeight: 700,
                lineHeight: 1.1,
                letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.78)',
                textShadow: keySafe ? 'none' : GIORGIA.labelShadow,
                ...(supportWraps ? { overflowWrap: 'anywhere' } : { whiteSpace: 'nowrap' })
              }}
            >
              {supportText}
            </div>
          ) : null}
          {showPlaybackProgress ? (
            <div
              className='modoitaliano-giorgia-clock-progress'
              aria-hidden='true'
              style={{ marginTop: '16px', height: '2px', background: 'rgba(255,255,255,0.4)' }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  background: GIORGIA.signal,
                  transform: `scaleX(${progress})`,
                  transformOrigin: 'left center',
                  transition: 'transform 140ms linear'
                }}
              />
            </div>
          ) : null}
        </div>
        </div>
      </div>
    );

  if (!header && !onAir) return null;

  return (
    <>
      {header}
      {onAir}
    </>
  );
};
