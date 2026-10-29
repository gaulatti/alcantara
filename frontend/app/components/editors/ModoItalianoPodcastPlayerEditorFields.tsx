import { TooltipButton } from "../BleeckerButtons";
import React, { useMemo, useState, useEffect } from 'react';
import { Field, Checkbox, Input } from '@gaulatti/bleecker';
import type { MediaGroup, MediaItem } from '../../models/broadcast';
import { apiUrl } from '../../utils/apiBaseUrl';

export function ModoItalianoPodcastPlayerEditorFields({
  componentType,
  props,
  updateProp,
  mediaGroups,
  isLoadingMediaGroups
}: {
  componentType: string;
  props: {
    show?: boolean;
    coverUrl?: string;
    episodeTitle?: string;
    showName?: string;
    audioUrl?: string;
  };
  updateProp: (componentType: string, propName: string, value: any) => void;
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
}) {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Search the full media library on the server (the endpoint is paginated: { data, meta })
  useEffect(() => {
    const term = search.trim();
    if (!term) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setIsLoadingAll(true);
      setSearchError(null);
      fetch(apiUrl(`/media?search=${encodeURIComponent(term)}&limit=48`), { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Media search failed (${r.status})`);
          return r.json() as Promise<{ data: MediaItem[] }>;
        })
        .then((body) => setSearchResults(body.data.filter((m) => !!m.imageUrl)))
        .catch((error: Error) => {
          if (controller.signal.aborted) return;
          setSearchResults([]);
          setSearchError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoadingAll(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  const filteredImages = useMemo(
    () => searchResults.map((m) => ({ url: m.imageUrl, label: m.name })),
    [searchResults],
  );

  return (
    <div className='space-y-4'>
      {/* Show toggle */}
      <label className='flex items-center gap-2 text-sm text-text-primary'>
        <Checkbox
          checked={typeof props.show === 'boolean' ? props.show : true}
          onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
        />
        Show Player
      </label>

      {/* Episode title */}
      <Field label='Episode Title'>
        <Input
          type='text'
          value={props.episodeTitle || ''}
          onChange={(e) => updateProp(componentType, 'episodeTitle', e.target.value)}
          placeholder='Estrenos: 29 de Mayo'
        />
      </Field>

      {/* Show name */}
      <Field label='Show / Author'>
        <Input
          type='text'
          value={props.showName || ''}
          onChange={(e) => updateProp(componentType, 'showName', e.target.value)}
          placeholder='ModoItaliano'
        />
      </Field>

      {/* Audio URL */}
      <Field label='Audio URL (MP3 / AAC)'>
        <Input
          type='text'
          value={props.audioUrl || ''}
          onChange={(e) => updateProp(componentType, 'audioUrl', e.target.value)}
          placeholder='https://example.com/episode.mp3'
        />
      </Field>

      {/* Cover art */}
      <div className='space-y-2'>
        <label className='block text-xs text-text-secondary'>Cover Art</label>

        {/* Selected preview */}
        {props.coverUrl ? (
          <div className='flex items-center gap-3 rounded border border-sea/40 bg-sea/5 p-2'>
            <img src={props.coverUrl} alt='Selected cover' className='h-14 w-14 rounded object-cover shrink-0 border border-sand/30' />
            <div className='flex-1 min-w-0'>
              <p className='text-xs text-text-primary truncate'>{props.coverUrl.split('/').pop()}</p>
              <TooltipButton type='button' onClick={() => updateProp(componentType, 'coverUrl', '')} className='mt-1 text-xs text-terracotta hover:underline'>
                Clear
              </TooltipButton>
            </div>
          </div>
        ) : null}

        {/* Search — searches full media library */}
        <Input
          type='text'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search all media by name…'
          className='w-full px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-sea/50'
        />

        {isLoadingAll && <p className='text-xs text-text-secondary'>Searching media library…</p>}
        {searchError && <p className='text-xs text-terracotta'>{searchError}</p>}

        {search.trim() && !searchError && (
          <div className='max-h-52 overflow-y-auto rounded border border-sand/30 p-2'>
            {filteredImages.length === 0 ? (
              <p className='text-xs text-text-secondary italic py-3 text-center'>No images match &ldquo;{search}&rdquo;</p>
            ) : (
              <div className='grid grid-cols-4 gap-2'>
                {filteredImages.map(({ url, label }) => {
                  const isSelected = props.coverUrl === url;
                  return (
                    <TooltipButton
                      key={url}
                      type='button'
                      title={label}
                      onClick={() => updateProp(componentType, 'coverUrl', isSelected ? '' : url)}
                      className={`relative rounded overflow-hidden border-2 transition-colors ${
                        isSelected ? 'border-sea' : 'border-transparent hover:border-sand/50'
                      }`}
                    >
                      <img src={url} alt={label} className='h-16 w-full object-cover block' />
                      {isSelected && (
                        <div className='absolute inset-0 bg-sea/20 flex items-center justify-center'>
                          <span className='text-white text-lg font-bold drop-shadow'>✓</span>
                        </div>
                      )}
                    </TooltipButton>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

