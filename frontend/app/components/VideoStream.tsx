import { useEffect, useMemo, useRef, useState } from 'react';

interface VideoStreamProps {
  sourceUrl?: unknown;
  posterUrl?: unknown;
  showControls?: unknown;
  loop?: unknown;
  autoPlay?: unknown;
  objectFit?: unknown;
  channelGain?: unknown;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

/** How far an element's volume may differ from the channel gain (hosts round it) before it is set again. */
const VOLUME_TOLERANCE = 0.01;

function normalizeGain(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function isLikelyHlsSource(url: string): boolean {
  return url.trim().toLowerCase().includes('.m3u8');
}

function isNonFatalPlayError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybeName = (error as { name?: unknown }).name;
  return maybeName === 'NotAllowedError' || maybeName === 'AbortError';
}

export function VideoStream({
  sourceUrl,
  posterUrl,
  showControls = false,
  loop = false,
  autoPlay = true,
  objectFit = 'cover',
  channelGain = 1
}: VideoStreamProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasPlaybackError, setHasPlaybackError] = useState(false);
  const resolvedSourceUrl = normalizeUrl(sourceUrl);
  const resolvedPosterUrl = normalizeUrl(posterUrl);
  const shouldShowControls = toBoolean(showControls, false);
  const shouldLoop = toBoolean(loop, false);
  const shouldAutoPlay = toBoolean(autoPlay, true);
  const resolvedObjectFit = objectFit === 'contain' ? 'contain' : 'cover';
  const resolvedChannelGain = normalizeGain(channelGain, 1);
  const resolvedMuted = resolvedChannelGain <= 0.0001;
  const videoKey = useMemo(
    () => `${resolvedSourceUrl}|${resolvedPosterUrl}|${resolvedObjectFit}`,
    [resolvedSourceUrl, resolvedPosterUrl, resolvedObjectFit]
  );

  useEffect(() => {
    setHasPlaybackError(false);
  }, [videoKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resolvedSourceUrl) {
      return;
    }
    let didCancel = false;
    let hlsInstance: { destroy: () => void } | null = null;

    const startPlayback = () => {
      if (!shouldAutoPlay) {
        return;
      }
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((error: unknown) => {
          if (!didCancel && !isNonFatalPlayError(error)) {
            setHasPlaybackError(true);
          }
        });
      }
    };

    const useNativePlayback = () => {
      video.src = resolvedSourceUrl;
      video.load();
      startPlayback();
    };

    const nativeHlsSupport =
      video.canPlayType('application/vnd.apple.mpegurl') !== '' || video.canPlayType('application/x-mpegURL') !== '';

    if (!isLikelyHlsSource(resolvedSourceUrl) || nativeHlsSupport) {
      useNativePlayback();
      return () => {
        didCancel = true;
      };
    }

    const setupHls = async () => {
      try {
        const { default: Hls } = await import('hls.js');
        if (didCancel) {
          return;
        }
        if (!Hls.isSupported()) {
          useNativePlayback();
          return;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true
        });
        hlsInstance = hls;
        hls.attachMedia(video);
        hls.loadSource(resolvedSourceUrl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          startPlayback();
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!didCancel && data?.fatal) {
            setHasPlaybackError(true);
          }
        });
      } catch (error) {
        console.error('Failed to initialize HLS playback:', error);
        if (!didCancel) {
          setHasPlaybackError(true);
        }
      }
    };

    setupHls();

    return () => {
      didCancel = true;
      if (hlsInstance) {
        hlsInstance.destroy();
      }
    };
  }, [resolvedSourceUrl, shouldAutoPlay, videoKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // The scene's channel gain decides the program's level, on every new element too. Some hosts
    // move the element's volume on their own once it plays: WebKitGTK under PipeWire reflects the
    // level the system restored for the app's last stream (0 after a muted, staged scene), which
    // left a video scene silent after a take. So the gain is applied again when the element plays
    // and whenever its volume changes away from it.
    const applyGain = () => {
      if (Math.abs(video.volume - resolvedChannelGain) > VOLUME_TOLERANCE) {
        video.volume = resolvedChannelGain;
      }
      if (video.muted !== resolvedMuted) {
        video.muted = resolvedMuted;
      }
    };
    applyGain();
    video.addEventListener('playing', applyGain);
    video.addEventListener('volumechange', applyGain);
    return () => {
      video.removeEventListener('playing', applyGain);
      video.removeEventListener('volumechange', applyGain);
    };
  }, [resolvedChannelGain, resolvedMuted, videoKey]);

  if (!resolvedSourceUrl) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        overflow: 'hidden'
      }}
    >
      <video
        key={videoKey}
        ref={videoRef}
        poster={resolvedPosterUrl || undefined}
        muted={resolvedMuted}
        loop={shouldLoop}
        controls={shouldShowControls}
        autoPlay={shouldAutoPlay}
        playsInline
        preload='auto'
        style={{
          width: '100%',
          height: '100%',
          objectFit: resolvedObjectFit,
          backgroundColor: '#000'
        }}
        onPlaying={() => {
          setHasPlaybackError(false);
        }}
        onError={() => {
          setHasPlaybackError(true);
        }}
      />
      {hasPlaybackError ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.5)',
            color: '#fff',
            fontSize: '22px',
            fontWeight: 600,
            letterSpacing: '0.02em',
            textTransform: 'uppercase'
          }}
        >
          Video stream unavailable
        </div>
      ) : null}
    </div>
  );
}
