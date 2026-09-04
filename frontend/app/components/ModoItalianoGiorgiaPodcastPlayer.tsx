import React, { useEffect, useRef, useState } from 'react';
import type { ModoItalianoPodcastPlayerProps } from './ModoItalianoPodcastPlayer';

const THEME = {
  signal: '#ed0076',
  navy: '#0a1234',
  font: "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif",
};

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/** Independent Giorgia presentation; the original podcast player remains unchanged. */
export function ModoItalianoGiorgiaPodcastPlayer({
  show = true, coverUrl = '', episodeTitle = '', showName = '', audioUrl = '', masterGain = 1,
}: ModoItalianoPodcastPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [seekingFocused, setSeekingFocused] = useState(false);

  async function play() {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    try {
      if (!contextRef.current) {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.85;
        context.createMediaElementSource(audio).connect(analyser);
        analyser.connect(context.destination);
        contextRef.current = context;
        analyserRef.current = analyser;
      }
      await contextRef.current.resume();
      await audio.play();
      setBlocked(false);
    } catch {
      if (audio.error) setFailed(true);
      else setBlocked(true);
    }
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Number.isFinite(masterGain) ? Math.max(0, Math.min(1, masterGain)) : 0;
    audio.muted = masterGain <= 0.0001;
  }, [masterGain, show]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    setCurrentTime(0);
    setDuration(0);
    setBlocked(false);
    setFailed(false);
    audio.load();
    return () => audio.pause();
  }, [audioUrl, show]);

  useEffect(() => {
    if (!show) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const data = new Uint8Array(128);
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = THEME.signal;
      const playing = audioRef.current && !audioRef.current.paused;
      if (playing && analyserRef.current && !motion.matches) {
        analyserRef.current.getByteFrequencyData(data);
        for (let i = 0; i < 80; i++) {
          const height = Math.max(2, (data[i] ?? 0) / 255 * 100);
          ctx.globalAlpha = 0.5 + height / 200;
          ctx.fillRect(i * 12, (120 - height) / 2, 5, height);
        }
      } else {
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, 59, canvas.width, 2);
      }
      frame = window.requestAnimationFrame(draw);
    };
    draw();
    return () => window.cancelAnimationFrame(frame);
  }, [show]);

  useEffect(() => () => {
    void contextRef.current?.close();
    contextRef.current = null;
    analyserRef.current = null;
  }, []);

  // Keep the audio node mounted so the analyser remains attached across visibility changes.
  return (
    <div hidden={!show} aria-label='Modo Italiano Giorgia podcast player' style={{
      position: 'absolute', inset: 0, overflow: 'hidden', color: '#fff', fontFamily: THEME.font,
      display: show ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center',
    }}>
      {coverUrl && <img src={coverUrl} alt='Episode cover' style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
        objectPosition: 'center center', filter: 'saturate(0.84) contrast(1.07)',
      }} />}
      <div aria-hidden='true' style={{ position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(10,18,52,0.48), rgba(10,18,52,0.04) 30%, rgba(10,18,52,0.66) 58%, rgba(10,18,52,0.98) 100%), linear-gradient(90deg, rgba(10,18,52,0.32), transparent 70%)',
      }} />
      <audio ref={audioRef} src={audioUrl || undefined} crossOrigin='anonymous' preload='metadata'
        onCanPlay={() => { if (show) void play(); }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onError={() => setFailed(true)}
      />
      <section aria-label='Episode artwork and title' style={{ position: 'absolute', inset: 0 }}>
        {!coverUrl && <p style={{ position: 'absolute', top: '100px', left: '110px', fontSize: '32px' }}>No cover selected</p>}
        <div style={{ position: 'absolute', left: '110px', right: '110px', bottom: '280px', paddingLeft: '44px', borderLeft: `10px solid ${THEME.signal}` }}>
            <p style={{ margin: '0 0 26px', fontFamily: THEME.font, fontSize: '34px', fontWeight: 600, color: '#fff',
              letterSpacing: '0.12em', textTransform: 'uppercase', overflowWrap: 'anywhere' }}>{showName}</p>
            <h1 style={{ margin: 0, maxWidth: '1560px', fontFamily: THEME.font, fontSize: episodeTitle.length > 90 ? '100px' : episodeTitle.length > 60 ? '124px' : '164px', lineHeight: 0.92,
              fontWeight: 700, letterSpacing: '-0.025em', textTransform: 'uppercase', textWrap: 'balance', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', textShadow: '0 8px 36px rgba(0,0,0,0.45)' }}>{episodeTitle}</h1>
        </div>
      </section>
      <div style={{ position: 'absolute', left: '110px', right: '110px', bottom: '64px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <canvas ref={canvasRef} width={960} height={120} aria-hidden='true' style={{ width: '100%', height: '70px', display: 'block', opacity: 0.85 }} />
          <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center', outline: seekingFocused ? '2px solid white' : 'none', outlineOffset: '5px' }}>
            <div aria-hidden='true' style={{ position: 'absolute', left: 0, right: 0, height: '3px', background: 'rgba(255,255,255,0.22)' }}>
              <div style={{ height: '100%', width: `${duration > 0 ? Math.min(100, currentTime / duration * 100) : 0}%`, background: THEME.signal }} />
            </div>
            <input aria-label='Episode progress' type='range' min={0} max={duration || 0} step={0.1}
              value={Math.min(currentTime, duration)} disabled={!duration}
              onFocus={() => setSeekingFocused(true)} onBlur={() => setSeekingFocused(false)}
              onChange={(event) => { if (audioRef.current) audioRef.current.currentTime = Number(event.target.value); }}
              style={{ position: 'relative', width: '100%', height: '20px', margin: 0, opacity: 0, cursor: 'pointer' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '30px', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.7)' }}>
            <span>{timestamp(currentTime)}</span><span>{timestamp(duration)}</span>
          </div>
          {failed ? <p role='alert' style={{ margin: 0, fontSize: '28px' }}>Unable to play this audio.</p>
            : blocked ? <button onClick={() => void play()} style={{ alignSelf: 'flex-start', border: `1px solid ${THEME.signal}`, color: '#fff',
              background: THEME.navy, padding: '8px 18px', fontFamily: THEME.font, fontSize: '28px' }}>Start playback</button> : null}
      </div>
    </div>
  );
}
