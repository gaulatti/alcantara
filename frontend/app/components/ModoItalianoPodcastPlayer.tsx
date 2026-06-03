import React, { useEffect, useRef, useState } from 'react';

export interface ModoItalianoPodcastPlayerProps {
  show?: boolean;
  coverUrl?: string;
  episodeTitle?: string;
  showName?: string;
  audioUrl?: string;
}

const ACCENT_COLOR = '#e91e8c';
const FONT_DISPLAY = "'Barlow Condensed', 'Encode Sans', system-ui, sans-serif";
const FONT_LABEL = "'Outfit', 'Encode Sans', system-ui, sans-serif";

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// (controls removed — scrubber-only UI)

export const ModoItalianoPodcastPlayer: React.FC<ModoItalianoPodcastPlayerProps> = ({
  show = true,
  coverUrl = '',
  episodeTitle = '',
  showName = '',
  audioUrl = ''
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const vizCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const bgRafRef = useRef<number | null>(null);
  const vizRafRef = useRef<number | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const timeArrayRef = useRef<Uint8Array | null>(null);
  const bgTimeRef = useRef(0);

  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // ── Background canvas animation ──────────────────────────────────────────
  // Smooth animated mesh gradient: 4 color orbs drifting on slow sine paths,
  // blended into a single radial gradient fill each frame.
  useEffect(() => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;

    const orbs = [
      { x: 0.15, y: 0.35, r: 0.7, hue: 82,  sat: 100, spd: 0.00031, phase: 0.0 },  // yellow-green
      { x: 0.80, y: 0.25, r: 0.6, hue: 22,  sat: 100, spd: 0.00027, phase: 1.1 },  // orange
      { x: 0.55, y: 0.75, r: 0.55, hue: 330, sat: 90,  spd: 0.00019, phase: 2.3 }, // pink
      { x: 0.10, y: 0.80, r: 0.5, hue: 48,  sat: 100, spd: 0.00023, phase: 3.7 },  // amber
    ];

    const draw = (ts: number) => {
      const W = canvas.width;
      const H = canvas.height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return;

      ctx.clearRect(0, 0, W, H);

      // Semi-transparent tint — lets layers behind show through
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(10, 18, 52, 0.55)';
      ctx.fillRect(0, 0, W, H);

      for (const orb of orbs) {
        const t = ts * orb.spd + orb.phase;
        const cx = (orb.x + Math.sin(t) * 0.22 + Math.cos(t * 0.6) * 0.1) * W;
        const cy = (orb.y + Math.cos(t * 0.8) * 0.18 + Math.sin(t * 0.4) * 0.12) * H;
        const radius = orb.r * Math.max(W, H);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0,   `hsla(${orb.hue}, ${orb.sat}%, 60%, 0.55)`);
        grad.addColorStop(0.5, `hsla(${orb.hue}, ${orb.sat}%, 40%, 0.2)`);
        grad.addColorStop(1,   `hsla(${orb.hue}, ${orb.sat}%, 20%, 0)`);

        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.globalCompositeOperation = 'source-over';
      // Vignette
      const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, H * 0.85);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);

      bgRafRef.current = requestAnimationFrame(draw);
    };

    bgRafRef.current = requestAnimationFrame(draw);
    return () => { if (bgRafRef.current !== null) cancelAnimationFrame(bgRafRef.current); };
  }, []);

  // ── Waveform visualizer ──────────────────────────────────────────────────
  // When playing: mirrored FFT bar visualizer.
  // When paused / no audio: gentle idle sine wave.
  useEffect(() => {
    const canvas = vizCanvasRef.current;
    if (!canvas) return;
    let idleT = 0;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const analyser = analyserRef.current;
      const freqArr = dataArrayRef.current;
      const timeArr = timeArrayRef.current;

      if (analyser && freqArr && isPlayingRef.current) {
        // ── Live: frequency bar spectrum ──
        analyser.getByteFrequencyData(freqArr);
        // Use first 60% of bins (the rest is ultrasonic/silence)
        const usableBins = Math.floor(freqArr.length * 0.6);
        const barW = W / usableBins;
        const mid = H / 2;

        for (let i = 0; i < usableBins; i++) {
          const mag = freqArr[i]! / 255;
          const barH = mag * mid * 0.95;
          if (barH < 1) continue;
          // Hue: deep pink at low freq → cyan at high freq
          const hue = 310 - i / usableBins * 200;
          const alpha = 0.5 + mag * 0.5;
          ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;
          // Mirrored: draw from center up and down
          ctx.fillRect(i * barW, mid - barH, Math.max(1, barW - 1), barH);
          ctx.fillRect(i * barW, mid,        Math.max(1, barW - 1), barH);
        }
        // Center line
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(0, mid - 0.5, W, 1);
      } else {
        // ── Idle: breathing flat line ──
        idleT += 0.04;
        const mid = H / 2;
        const amp = 6 + Math.sin(idleT * 0.7) * 4;
        const freq = 8;

        // Glow
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(233,30,140,0.18)';
        ctx.lineWidth = 8;
        for (let x = 0; x <= W; x += 2) {
          const y = mid + Math.sin((x / W) * Math.PI * freq + idleT * 2) * amp;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Line
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(233,30,140,0.6)';
        ctx.lineWidth = 1.5;
        for (let x = 0; x <= W; x += 2) {
          const y = mid + Math.sin((x / W) * Math.PI * freq + idleT * 2) * amp;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      vizRafRef.current = requestAnimationFrame(draw);
    };

    vizRafRef.current = requestAnimationFrame(draw);
    return () => { if (vizRafRef.current !== null) cancelAnimationFrame(vizRafRef.current); };
  }, []);

  // ── Audio events ─────────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => { currentTimeRef.current = audio.currentTime; setCurrentTime(audio.currentTime); };
    const onDurationChange = () => { durationRef.current = audio.duration ?? 0; setDuration(audio.duration ?? 0); };
    const onPlay = () => { isPlayingRef.current = true; setIsPlaying(true); setAutoplayBlocked(false); };
    const onPause = () => { isPlayingRef.current = false; setIsPlaying(false); };
    const onEnded = () => { isPlayingRef.current = false; setIsPlaying(false); };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onDurationChange);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onDurationChange);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  // ── Web Audio analyser setup ─────────────────────────────────────────────
  const initAnalyser = () => {
    const audio = audioRef.current;
    if (!audio || analyserRef.current) return;
    try {
      const actx = new AudioContext();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      const source = actx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(actx.destination);
      audioCtxRef.current = actx;
      analyserRef.current = analyser;
      sourceRef.current = source;
      dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
      timeArrayRef.current = new Uint8Array(analyser.fftSize);
    } catch { /* SSR / restricted */ }
  };

  // ── Load + autoplay ──────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    currentTimeRef.current = 0; durationRef.current = 0; isPlayingRef.current = false;
    setCurrentTime(0); setDuration(0); setIsPlaying(false); setAutoplayBlocked(false);
    if (!audioUrl) return;
    audio.src = audioUrl;
    audio.load();
    const tryPlay = () => {
      initAnalyser();
      if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume();
      audio.play().catch(() => setAutoplayBlocked(true));
    };
    audio.addEventListener('canplay', tryPlay, { once: true });
    return () => { audio.removeEventListener('canplay', tryPlay); };
  }, [audioUrl]);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (bgRafRef.current !== null) cancelAnimationFrame(bgRafRef.current);
      if (vizRafRef.current !== null) cancelAnimationFrame(vizRafRef.current);
      void audioCtxRef.current?.close();
    };
  }, []);

  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    initAnalyser();
    if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume();
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  };

  const handleSkip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
  };

  const handleSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current;
    if (!audio || !durationRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(durationRef.current, (e.clientX - rect.left) / rect.width * durationRef.current));
  };

  if (!show) return null;

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Full-canvas animated gradient background */}
      <canvas
        ref={bgCanvasRef}
        width={1920}
        height={1080}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {/* Hidden audio element */}
      <audio ref={audioRef} crossOrigin='anonymous' preload='metadata' />

      {/* Glass card */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'stretch',
          width: '1800px',
          height: '540px',
          background: 'rgba(12, 12, 12, 0.62)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          borderRadius: '32px',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.07)',
          overflow: 'hidden',
        }}
      >
        {/* Cover art — full card height, no padding */}
        <div style={{ flexShrink: 0, width: '540px', height: '100%', overflow: 'hidden', background: '#1a1a1a' }}>
          {coverUrl ? (
            <img src={coverUrl} alt='Episode cover' style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, #2a2a2a, #111)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width='64' height='64' viewBox='0 0 64 64' fill='none'>
                <circle cx='32' cy='32' r='24' stroke='rgba(255,255,255,0.15)' strokeWidth='2' />
                <circle cx='32' cy='32' r='8' fill='rgba(255,255,255,0.1)' />
              </svg>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '54px 66px', gap: '27px' }}>
          {/* Title + show name */}
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: '78px', fontWeight: 700, color: '#fff', lineHeight: 1.1, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {episodeTitle || 'Episode Title'}
            </div>
            <div style={{ fontFamily: FONT_LABEL, fontSize: '39px', fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginTop: '9px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {showName || 'Show Name'}
            </div>
          </div>

          {/* Waveform visualizer */}
          <div style={{ position: 'relative', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', overflow: 'hidden', flex: 1 }}>
            <canvas
              ref={vizCanvasRef}
              width={720}
              height={120}
              style={{ display: 'block', width: '100%', height: '100%' }}
            />
          </div>

          {/* Progress scrubber */}
          <div style={{ position: 'relative', height: '6px', background: 'rgba(255,255,255,0.12)', borderRadius: '3px', cursor: 'pointer' }}
            onClick={(e) => {
              const audio = audioRef.current;
              if (!audio || !durationRef.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              audio.currentTime = Math.max(0, Math.min(durationRef.current, (e.clientX - rect.left) / rect.width * durationRef.current));
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${progress * 100}%`, background: ACCENT_COLOR, borderRadius: '2px', transition: 'width 0.1s linear' }} />
            <div style={{ position: 'absolute', top: '50%', left: `${progress * 100}%`, transform: 'translate(-50%, -50%)', width: '18px', height: '18px', borderRadius: '50%', background: ACCENT_COLOR, boxShadow: `0 0 12px ${ACCENT_COLOR}`, pointerEvents: 'none' }} />
          </div>

          {/* Time stamps */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT_LABEL, fontSize: '30px', fontWeight: 500, color: 'rgba(255,255,255,0.45)', marginTop: '-12px' }}>
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>

          {/* Autoplay blocked prompt */}
          {autoplayBlocked && (
            <div style={{ fontFamily: FONT_LABEL, fontSize: '14px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Waiting for interaction to start playback
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
