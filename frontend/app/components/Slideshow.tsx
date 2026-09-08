import { useCallback, useEffect, useMemo, useState } from 'react';

interface SlideshowProps {
  images?: unknown;
  intervalMs?: unknown;
  transitionMs?: unknown;
  shuffle?: unknown;
  fitMode?: unknown;
  kenBurns?: unknown;
}

function toNumber(value: unknown, fallback: number, min: number, max: number): number {
  const next = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(next)));
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

function normalizeImageUrls(value: unknown): string[] {
  const pushFromString = (raw: string, bucket: string[]) => {
    raw
      .split(/[\n,]/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => bucket.push(entry));
  };

  const collected: string[] = [];

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (typeof entry === 'string') {
        pushFromString(entry, collected);
        return;
      }

      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        if (typeof record.url === 'string') {
          pushFromString(record.url, collected);
        }
      }
    });
  } else if (typeof value === 'string') {
    pushFromString(value, collected);
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      record.items.forEach((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const entryRecord = entry as Record<string, unknown>;
          if (typeof entryRecord.url === 'string') {
            pushFromString(entryRecord.url, collected);
          }
        }
      });
    }
    if (Array.isArray(record.images)) {
      record.images.forEach((entry) => {
        if (typeof entry === 'string') {
          pushFromString(entry, collected);
        }
      });
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  collected.forEach((url) => {
    if (seen.has(url)) {
      return;
    }
    seen.add(url);
    unique.push(url);
  });
  return unique;
}

function pickNextLoadedIndex(current: number, loadedIndices: number[], shuffle: boolean): number {
  if (loadedIndices.length <= 1) {
    return loadedIndices[0] ?? 0;
  }

  const currentPosition = loadedIndices.indexOf(current);
  if (!shuffle) {
    return loadedIndices[(currentPosition + 1) % loadedIndices.length] ?? loadedIndices[0];
  }
  if (currentPosition < 0) {
    return loadedIndices[0];
  }

  let nextPosition = currentPosition;
  while (nextPosition === currentPosition) {
    nextPosition = Math.floor(Math.random() * loadedIndices.length);
  }
  return loadedIndices[nextPosition];
}

export function Slideshow({
  images,
  intervalMs = 5000,
  transitionMs = 900,
  shuffle = false,
  fitMode = 'cover',
  kenBurns = true
}: SlideshowProps) {
  const imageUrls = useMemo(() => normalizeImageUrls(images), [images]);
  const displayMs = toNumber(intervalMs, 5000, 1000, 60000);
  const fadeMs = toNumber(transitionMs, 900, 100, 5000);
  const shouldShuffle = toBoolean(shuffle, false);
  const shouldKenBurns = toBoolean(kenBurns, true);
  const imageFit = fitMode === 'contain' ? 'contain' : 'cover';
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadedUrls, setLoadedUrls] = useState<Set<string>>(() => new Set());
  const imageUrlsKey = imageUrls.join('\u0000');
  const loadedIndices = useMemo(
    () =>
      imageUrls.reduce<number[]>((indices, url, index) => {
        if (loadedUrls.has(url)) indices.push(index);
        return indices;
      }, []),
    [imageUrlsKey, loadedUrls]
  );

  const markImageLoaded = useCallback((url: string) => {
    setLoadedUrls((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }, []);

  const markImageFailed = useCallback((url: string) => {
    setLoadedUrls((current) => {
      if (!current.has(url)) return current;
      const next = new Set(current);
      next.delete(url);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!imageUrls.length) {
      setActiveIndex(0);
      setLoadedUrls(new Set());
      return;
    }
    setActiveIndex((current) => Math.min(current, imageUrls.length - 1));
    setLoadedUrls((current) => new Set([...current].filter((url) => imageUrls.includes(url))));
  }, [imageUrlsKey]);

  useEffect(() => {
    if (loadedIndices.length > 0 && !loadedIndices.includes(activeIndex)) {
      setActiveIndex(loadedIndices[0]);
    }
  }, [activeIndex, loadedIndices]);

  useEffect(() => {
    if (loadedIndices.length <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) => pickNextLoadedIndex(current, loadedIndices, shouldShuffle));
    }, displayMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [imageUrlsKey, loadedIndices, displayMs, shouldShuffle]);

  if (!imageUrls.length) {
    return null;
  }

  const motionDurationMs = Math.max(displayMs + fadeMs, 2200);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#000'
      }}
    >
      <style>{`
        @keyframes slideshowKenBurns {
          0% { transform: scale(1) translate3d(0, 0, 0); }
          100% { transform: scale(1.08) translate3d(-1.25%, -1.25%, 0); }
        }
      `}</style>

      {imageUrls.map((url, index) => {
        const isActive = index === activeIndex && loadedUrls.has(url);
        return (
          <img
            key={url}
            src={url}
            alt={`Slideshow frame ${index + 1}`}
            loading='eager'
            decoding='async'
            onLoad={() => markImageLoaded(url)}
            onError={() => markImageFailed(url)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: imageFit,
              opacity: isActive ? 1 : 0,
              zIndex: isActive ? 2 : 1,
              transition: `opacity ${fadeMs}ms ease-in-out`,
              willChange: 'opacity, transform',
              animation: isActive && shouldKenBurns ? `slideshowKenBurns ${motionDurationMs}ms ease-out both` : undefined
            }}
          />
        );
      })}
    </div>
  );
}
