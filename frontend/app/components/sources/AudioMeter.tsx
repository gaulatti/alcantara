import React, { useEffect, useState } from 'react';

export interface AudioMeterProps {
  level?: number;
  audioTrack?: any;
  label?: string;
  className?: string;
}

export function AudioMeter({
  level: externalLevel,
  audioTrack,
  label = 'Audio level',
  className = '',
}: AudioMeterProps) {
  const [computedLevel, setComputedLevel] = useState<number>(0);

  useEffect(() => {
    if (typeof externalLevel === 'number') {
      setComputedLevel(Math.max(0, Math.min(100, externalLevel)));
      return;
    }

    if (!audioTrack || typeof window === 'undefined') {
      setComputedLevel(0);
      return;
    }

    let animationFrameId: number;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;

    try {
      const mediaStreamTrack = audioTrack.mediaStreamTrack || audioTrack;
      if (mediaStreamTrack instanceof MediaStreamTrack) {
        const stream = new MediaStream([mediaStreamTrack]);
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          audioContext = new AudioCtx();
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 64;
          sourceNode = audioContext.createMediaStreamSource(stream);
          sourceNode.connect(analyser);

          const buffer = new Uint8Array(analyser.frequencyBinCount);
          const update = () => {
            if (!analyser) return;
            analyser.getByteFrequencyData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
              sum += buffer[i];
            }
            const avg = sum / buffer.length;
            const norm = Math.min(100, Math.round((avg / 255) * 100));
            setComputedLevel(norm);
            animationFrameId = requestAnimationFrame(update);
          };
          update();
        }
      }
    } catch {
      // AudioContext unavailable in test/headless environments
      setComputedLevel(0);
    }

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      if (sourceNode) sourceNode.disconnect();
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
      }
    };
  }, [externalLevel, audioTrack]);

  const level = typeof externalLevel === 'number' ? Math.max(0, Math.min(100, externalLevel)) : computedLevel;

  // 10-bar LED style display
  const bars = 10;
  const activeBars = Math.round((level / 100) * bars);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={level}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`flex items-center gap-1.5 ${className}`}
      data-testid="audio-meter"
    >
      <div className="flex h-3 items-end gap-0.5 rounded bg-zinc-900/60 p-0.5 border border-zinc-700/50">
        {Array.from({ length: bars }).map((_, index) => {
          const isActive = index < activeBars;
          let barColor = 'bg-zinc-700';
          if (isActive) {
            if (index < 6) barColor = 'bg-emerald-500';
            else if (index < 8) barColor = 'bg-amber-400';
            else barColor = 'bg-rose-500';
          }
          return (
            <span
              key={index}
              data-testid={`meter-bar-${index}`}
              className={`w-1 rounded-xs transition-all duration-75 ${barColor} ${
                isActive ? 'h-full' : 'h-1/3 opacity-30'
              }`}
            />
          );
        })}
      </div>
      <span className="text-[10px] font-mono tabular-nums text-zinc-400 w-7 text-right">
        {level}%
      </span>
    </div>
  );
}
