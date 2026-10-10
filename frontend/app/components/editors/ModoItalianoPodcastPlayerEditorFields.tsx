import { TooltipButton } from "../BleeckerButtons";
import React, { useMemo, useState, useEffect, useRef } from 'react';
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
  const [allMedia, setAllMedia] = useState<MediaItem[]>([]);
  const [isLoadingAll, setIsLoadingAll] = useState(false);
  const fetchedRef = useRef(false);

  // Fetch full media library once when user starts typing
  useEffect(() => {
    if (!search.trim() || fetchedRef.current) return;
    fetchedRef.current = true;
    setIsLoadingAll(true);
    fetch(apiUrl('/media'))
      .then((r) => r.json())
      .then((data: MediaItem[]) => {
        setAllMedia(Array.isArray(data) ? data.filter((m) => !!m.imageUrl) : []);
      })
      .catch(() => {})
      .finally(() => setIsLoadingAll(false));
  }, [search]);

  // Grouped images from already-loaded media groups (instant, no fetch)
  const groupImages = useMemo(() => {
    const seen = new Set<string>();
    const result: { url: string; label: string }[] = [];
    for (const group of mediaGroups) {
      for (const item of group.items) {
        const url = item.media.imageUrl;
        if (url && !seen.has(url)) {
          seen.add(url);
          result.push({ url, label: `${group.name} — ${item.media.name}` });
        }
      }
    }
    return result;
  }, [mediaGroups]);

  const filteredImages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groupImages;
    // Search full library if loaded, otherwise search groups
    const pool = allMedia.length > 0
      ? allMedia.map((m) => ({ url: m.imageUrl, label: m.name }))
      : groupImages;
    return pool.filter(({ label }) => label.toLowerCase().includes(q));
  }, [search, allMedia, groupImages]);

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

        {isLoadingAll && <p className='text-xs text-text-secondary'>Loading full media library…</p>}

        {search.trim() && (
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

