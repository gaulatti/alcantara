import { useMemo } from 'react';

interface StreamWallProps {
  urls: string[];
  maxStreams?: number;
  title?: string;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function StreamWall({ urls, maxStreams = 4, title = 'Stream Wall' }: StreamWallProps) {
  const streams = useMemo(() => {
    const deduped = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
    return deduped.filter(isValidHttpUrl).slice(0, maxStreams);
  }, [maxStreams, urls]);

  return (
    <div className='h-full w-full overflow-hidden bg-black text-white'>
      <div className='flex h-full w-full flex-col'>
        {title.trim() ? (
          <header className='shrink-0 border-b border-white/20 px-4 py-2'>
            <div className='flex items-center justify-between'>
              <h1 className='text-sm font-semibold tracking-wide'>{title}</h1>
              <span className='text-xs text-white/70'>
                {streams.length}/{maxStreams} streams
              </span>
            </div>
          </header>
        ) : null}

        <main className='min-h-0 flex-1'>
          {streams.length === 0 ? (
            <div className='flex h-full items-center justify-center px-6 text-center text-sm text-white/70'>
              No valid stream URLs provided. Use query params like <code className='rounded bg-white/10 px-1.5 py-0.5'>?url=https://vdo.ninja/?view=...</code>{' '}
              (repeat up to {maxStreams}).
            </div>
          ) : (
            <div className='grid h-full w-full gap-px bg-white/10' style={{ gridTemplateColumns: `repeat(${streams.length}, minmax(0, 1fr))` }}>
              {streams.map((url, index) => (
                <section key={`${url}-${index}`} className='relative min-w-0 overflow-hidden bg-black'>
                  <iframe
                    src={url}
                    title={`Stream ${index + 1}`}
                    className='h-full w-full border-0'
                    allow='autoplay; camera; microphone; fullscreen; display-capture; clipboard-read; clipboard-write'
                    referrerPolicy='no-referrer'
                  />
                </section>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
