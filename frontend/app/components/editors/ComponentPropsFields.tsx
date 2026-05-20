import { useMemo } from 'react';
import { Input, Select, Textarea } from '@gaulatti/bleecker';
import { getTimezonesSortedByOffset, getTimezoneOptionLabel } from '../../utils/timezones';
import { SlideshowEditorFields } from './SlideshowEditorFields';
import { ToniChyronEditorFields } from './ToniChyronEditorFields';
import { RelojDigitalEditorFields } from './RelojDigitalEditorFields';
import { ProgramChyronEditorFields } from './ProgramChyronEditorFields';
import { ModoItalianoBracketEditorFields } from './ModoItalianoBracketEditorFields';
import { FIFTHBELL_AVAILABLE_WEATHER_CITIES, normalizeSceneInstantId } from '../../utils/broadcast';
import { createProgramTextSequence } from '../../utils/programSequence';
import type { SongCatalogItem, MediaGroup } from '../../models/broadcast';
import { getDefaultPropsForComponent } from '../../models/components';

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const n = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(n)) return true;
    if (['false', '0', 'no', 'off', ''].includes(n)) return false;
  }
  return fallback;
}

export function ComponentPropsFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  songCatalog,
  mediaGroups,
  isLoadingMediaGroups
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  songCatalog: SongCatalogItem[];
  mediaGroups: MediaGroup[];
  isLoadingMediaGroups: boolean;
}) {
  const timezoneOptions = useMemo(() => {
    const baseDate = new Date();
    return getTimezonesSortedByOffset(baseDate).map((tz) => ({ value: tz, label: getTimezoneOptionLabel(tz, baseDate) }));
  }, []);

  switch (componentType) {
    case 'ticker':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Hashtag</label>
            <Input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='#Hashtag'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>URL</label>
            <Input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='website.com'
            />
          </div>
        </div>
      );
    case 'chyron':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Chyron message'
            />
          </div>
        </div>
      );
    case 'header':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Title</label>
            <Input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Date</label>
            <Input
              type='text'
              value={props.date || ''}
              onChange={(e) => updateProp(componentType, 'date', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
        </div>
      );
    case 'live-indicator':
    case 'logo-widget':
    case 'toni-logo':
      return <p className='text-xs text-text-secondary italic'>No configurable attributes.</p>;
    case 'slideshow':
      return (
        <SlideshowEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          mediaGroups={mediaGroups}
          isLoadingMediaGroups={isLoadingMediaGroups}
        />
      );
    case 'video-stream':
      return (
        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Source URL</label>
            <Input
              type='text'
              value={props.sourceUrl || ''}
              onChange={(e) => updateProp(componentType, 'sourceUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com/stream.m3u8'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Poster URL (optional)</label>
            <Input
              type='text'
              value={props.posterUrl || ''}
              onChange={(e) => updateProp(componentType, 'posterUrl', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com/poster.jpg'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Fit Mode</span>
              <Select
                value={props.objectFit || 'cover'}
                onChange={(v) => updateProp(componentType, 'objectFit', v)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                options={[
                  { value: 'cover', label: 'Cover' },
                  { value: 'contain', label: 'Contain' }
                ]}
              />
            </label>
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.autoPlay, true)}
                onChange={(e) => updateProp(componentType, 'autoPlay', e.target.checked)}
                className='h-4 w-4'
              />
              Autoplay
            </label>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.loop, false)}
                onChange={(e) => updateProp(componentType, 'loop', e.target.checked)}
                className='h-4 w-4'
              />
              Loop
            </label>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showControls, false)}
                onChange={(e) => updateProp(componentType, 'showControls', e.target.checked)}
                className='h-4 w-4'
              />
              Show Native Controls
            </label>
          </div>
          <p className='text-xs text-text-secondary'>Audio is controlled by mixer Song + Main faders (including mute/solo behavior).</p>
        </div>
      );
    case 'stream-wall': {
      const urlsValue = Array.isArray(props.urls) ? props.urls.filter((u: unknown): u is string => typeof u === 'string') : [];
      const urlsText = urlsValue.join('\n');
      return (
        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Title (optional)</label>
            <Input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Optional wall title'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Max Streams (1-4)</label>
            <Input
              type='number'
              min={1}
              max={4}
              value={typeof props.maxStreams === 'number' ? props.maxStreams : 4}
              onChange={(e) => {
                const raw = Number(e.target.value);
                const normalized = Number.isFinite(raw) ? Math.max(1, Math.min(4, Math.round(raw))) : 4;
                updateProp(componentType, 'maxStreams', normalized);
              }}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Stream URLs (one per line)</label>
            <Textarea
              defaultValue={urlsText}
              onBlur={(e) => {
                const nextUrls = e.target.value
                  .split(/\n|,/)
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 4);
                updateProp(componentType, 'urls', nextUrls);
              }}
              rows={6}
              className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-sea/50'
              placeholder='https://vdo.ninja/?view=...'
            />
            <p className='mt-1 text-xs text-text-secondary'>Only http/https URLs are rendered. Streams are displayed in one horizontal row.</p>
          </div>
        </div>
      );
    }
    case 'scoreboard':
      return (
        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Title</label>
            <Input
              type='text'
              value={props.title || ''}
              onChange={(e) => updateProp(componentType, 'title', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='MATCH / FINAL / SEMIFINAL'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Home Team</label>
              <Input
                type='text'
                value={props.homeTeam || ''}
                onChange={(e) => updateProp(componentType, 'homeTeam', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='HOME'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Away Team</label>
              <Input
                type='text'
                value={props.awayTeam || ''}
                onChange={(e) => updateProp(componentType, 'awayTeam', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='AWAY'
              />
            </div>
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Home Score</label>
              <Input
                type='text'
                value={props.homeScore ?? '0'}
                onChange={(e) => updateProp(componentType, 'homeScore', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Away Score</label>
              <Input
                type='text'
                value={props.awayScore ?? '0'}
                onChange={(e) => updateProp(componentType, 'awayScore', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </div>
          </div>
          <div className='grid grid-cols-3 gap-3'>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Period</label>
              <Input
                type='text'
                value={props.period || ''}
                onChange={(e) => updateProp(componentType, 'period', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='1ST'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Clock</label>
              <Input
                type='text'
                value={props.clock || ''}
                onChange={(e) => updateProp(componentType, 'clock', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='12:34'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Status</label>
              <Input
                type='text'
                value={props.status || ''}
                onChange={(e) => updateProp(componentType, 'status', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='LIVE'
              />
            </div>
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showPeriod, true)}
                onChange={(e) => updateProp(componentType, 'showPeriod', e.target.checked)}
                className='h-4 w-4'
              />
              Show Period
            </label>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showClock, true)}
                onChange={(e) => updateProp(componentType, 'showClock', e.target.checked)}
                className='h-4 w-4'
              />
              Show Clock
            </label>
          </div>
        </div>
      );
    case 'qr-code':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>QR Code Content (URL or text)</label>
          <Input
            type='text'
            value={props.content || ''}
            onChange={(e) => updateProp(componentType, 'content', e.target.value)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            placeholder='https://example.com'
          />
          <p className='text-xs text-text-secondary mt-1'>Enter URL or text to encode in QR code</p>
        </div>
      );
    case 'broadcast-layout':
      return (
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Header Title</label>
            <Input
              type='text'
              value={props.headerTitle || ''}
              onChange={(e) => updateProp(componentType, 'headerTitle', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Program title'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Hashtag</label>
            <Input
              type='text'
              value={props.hashtag || ''}
              onChange={(e) => updateProp(componentType, 'hashtag', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>URL</label>
            <Input
              type='text'
              value={props.url || ''}
              onChange={(e) => updateProp(componentType, 'url', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </div>
          <div className='col-span-2'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showChyron, false)}
                onChange={(e) => updateProp(componentType, 'showChyron', e.target.checked)}
                className='h-4 w-4'
              />
              Show Chyron
            </label>
          </div>
          {toBoolean(props.showChyron, false) ? (
            <div className='col-span-2'>
              <label className='block text-xs text-text-secondary mb-1'>Chyron Text</label>
              <Input
                type='text'
                value={props.chyronText || ''}
                onChange={(e) => updateProp(componentType, 'chyronText', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Optional lower chyron text'
              />
            </div>
          ) : null}
          <div className='col-span-2'>
            <label className='block text-xs text-text-secondary mb-1'>QR Code Content</label>
            <Input
              type='text'
              value={props.qrCodeContent || ''}
              onChange={(e) => updateProp(componentType, 'qrCodeContent', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='https://example.com'
            />
          </div>
          <div className='col-span-2'>
            <label className='block text-xs text-text-secondary mb-1'>Clock Timezone</label>
            <Select
              value={props.clockTimezone || 'America/Argentina/Buenos_Aires'}
              onChange={(v) => updateProp(componentType, 'clockTimezone', v)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              options={timezoneOptions}
            />
          </div>
        </div>
      );
    case 'clock-widget':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Timezone</label>
          <Select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(v) => updateProp(componentType, 'timezone', v)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={timezoneOptions}
          />
        </div>
      );
    case 'reloj-clock':
      return (
        <div>
          <label className='block text-xs text-text-secondary mb-1'>Timezone</label>
          <Select
            value={props.timezone || 'America/Argentina/Buenos_Aires'}
            onChange={(v) => updateProp(componentType, 'timezone', v)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={timezoneOptions}
          />
        </div>
      );
    case 'reloj-loop-clock':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Starting Timezone</label>
            <Select
              value={props.timezone || 'Europe/Madrid'}
              onChange={(v) => updateProp(componentType, 'timezone', v)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              options={timezoneOptions}
            />
          </div>
          <p className='text-xs text-text-secondary'>Loop sequence: Madrid, Sanremo, New York, Santiago. Each timezone stays active for 30 seconds.</p>
        </div>
      );
    case 'reloj-digital-loop-clock':
      return (
        <RelojDigitalEditorFields
          componentType={componentType}
          props={props}
          updateProp={updateProp}
          replaceProps={replaceProps}
          commitProps={commitProps}
          timezoneOptions={timezoneOptions}
        />
      );
    case 'toni-chyron':
    case 'fifthbell-chyron':
      return (
        <ToniChyronEditorFields componentType={componentType} props={props} updateProp={updateProp} replaceProps={replaceProps} commitProps={commitProps} />
      );
    case 'modoitaliano-chyron':
      return (
        <ProgramChyronEditorFields componentType={componentType} props={props} updateProp={updateProp} replaceProps={replaceProps} commitProps={commitProps} />
      );
    case 'modoitaliano-clock':
      return null;
    case 'toni-clock':
    case 'fifthbell-clock': {
      const worldClockCitiesDefaultValue = JSON.stringify(Array.isArray(props.worldClockCities) ? props.worldClockCities : [], null, 2);
      const canToggleBellIcon = componentType === 'toni-clock';
      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.showWorldClocks, true)}
                onChange={(e) => updateProp(componentType, 'showWorldClocks', e.target.checked)}
                className='h-4 w-4'
              />
              Show World Clocks
            </label>
            {canToggleBellIcon ? (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showBellIcon, false)}
                  onChange={(e) => updateProp(componentType, 'showBellIcon', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bell Icon
              </label>
            ) : (
              <div className='text-sm text-text-secondary'>FifthBell clock icon is always enabled.</div>
            )}
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.worldClockShuffle, false)}
                onChange={(e) => updateProp(componentType, 'worldClockShuffle', e.target.checked)}
                className='h-4 w-4'
              />
              Shuffle world clocks
            </label>
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock rotate (ms)</span>
              <Input
                type='number'
                min={500}
                value={props.worldClockRotateIntervalMs ?? 5000}
                onChange={(e) => updateProp(componentType, 'worldClockRotateIntervalMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock transition (ms)</span>
              <Input
                type='number'
                min={0}
                value={props.worldClockTransitionMs ?? 300}
                onChange={(e) => updateProp(componentType, 'worldClockTransitionMs', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>World clock width (px)</span>
              <Input
                type='number'
                min={120}
                value={props.worldClockWidthPx ?? 200}
                onChange={(e) => updateProp(componentType, 'worldClockWidthPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
          </div>
          <div className='space-y-2'>
            <label className='block text-xs text-text-secondary'>World Clock Cities JSON</label>
            <Textarea
              defaultValue={worldClockCitiesDefaultValue}
              onBlur={(e) => {
                if (!e.target.value.trim()) {
                  updateProp(componentType, 'worldClockCities', []);
                  return;
                }
                try {
                  const parsed = JSON.parse(e.target.value);
                  if (!Array.isArray(parsed)) return;
                  const normalized = parsed
                    .map((item: any) => {
                      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
                      const city = typeof item.city === 'string' ? item.city.trim() : '';
                      const tz = typeof item.timezone === 'string' ? item.timezone.trim() : '';
                      return city && tz ? { city, timezone: tz } : null;
                    })
                    .filter(Boolean);
                  updateProp(componentType, 'worldClockCities', normalized);
                } catch (err) {
                  console.error('Invalid worldClockCities JSON:', err);
                }
              }}
              rows={6}
              className='w-full px-3 py-2 text-sm border rounded font-mono focus:ring-2 focus:ring-sea/50'
            />
            <p className='text-xs text-text-secondary'>Each item must be {'{ "city": "SANREMO", "timezone": "Europe/Rome" }'}.</p>
          </div>
        </div>
      );
    }
    case 'modoitaliano-disclaimer':
      return (
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Shown only when ModoItaliano chyron is hidden/empty.</p>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input
              type='text'
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='Disclaimer text'
            />
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
            <label className='flex items-center gap-2 text-sm text-text-primary'>
              <Input
                type='checkbox'
                checked={toBoolean(props.show, true)}
                onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
                className='h-4 w-4'
              />
              Show Disclaimer
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Alignment</span>
              <Select
                value={props.align || 'right'}
                onChange={(v) => updateProp(componentType, 'align', v)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' }
                ]}
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Bottom (px)</span>
              <Input
                type='number'
                min={0}
                value={props.bottomPx ?? 24}
                onChange={(e) => updateProp(componentType, 'bottomPx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
            <label className='text-sm text-text-primary'>
              <span className='block text-xs text-text-secondary mb-1'>Font Size (px)</span>
              <Input
                type='number'
                min={10}
                value={props.fontSizePx ?? 20}
                onChange={(e) => updateProp(componentType, 'fontSizePx', Number(e.target.value))}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              />
            </label>
          </div>
          <label className='text-sm text-text-primary block max-w-xs'>
            <span className='block text-xs text-text-secondary mb-1'>Opacity (0-1)</span>
            <Input
              type='number'
              min={0}
              max={1}
              step={0.05}
              value={props.opacity ?? 0.82}
              onChange={(e) => updateProp(componentType, 'opacity', Number(e.target.value))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
        </div>
      );
    case 'modoitaliano-bracket':
      return <ModoItalianoBracketEditorFields props={props} updateProp={updateProp} componentType={componentType} songCatalog={songCatalog} />;
    case 'cronica-background':
      return <p className='text-xs text-text-secondary italic'>No configurable fields for Cronica background.</p>;
    case 'cronica-chyron':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-text-primary'>
            Text (Multi-line supported)
            <Textarea
              value={props.text || ''}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 h-24'
              placeholder='Enter chyron text...'
            />
          </label>
        </div>
      );
    case 'cronica-reiteramos':
      return (
        <div className='space-y-3'>
          <label className='block text-sm text-text-primary'>
            Text
            <Input
              type='text'
              value={props.text || 'REITERAMOS'}
              onChange={(e) => updateProp(componentType, 'text', e.target.value)}
              className='mt-1 w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            />
          </label>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input
              type='checkbox'
              checked={toBoolean(props.show, true)}
              onChange={(e) => updateProp(componentType, 'show', e.target.checked)}
              className='h-4 w-4 text-sea focus:ring-sea/50 border-sand/40 rounded'
            />
            Show banner
          </label>
        </div>
      );
    case 'earone':
      return (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Label</label>
            <Input
              type='text'
              value={props.label || 'EARONE'}
              onChange={(e) => updateProp(componentType, 'label', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
              placeholder='EARONE'
            />
          </div>
          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Rank</label>
              <Input
                type='text'
                value={props.rank || ''}
                onChange={(e) => updateProp(componentType, 'rank', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Uses active sequence item'
              />
            </div>
            <div>
              <label className='block text-xs text-text-secondary mb-1'>Spins Today</label>
              <Input
                type='text'
                value={props.spins || ''}
                onChange={(e) => updateProp(componentType, 'spins', e.target.value)}
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='Uses active sequence item'
              />
            </div>
          </div>
          <p className='text-xs text-text-secondary'>Leave rank/spins blank to follow the active Toni chyron sequence item.</p>
        </div>
      );
    case 'fifthbell':
    case 'fifthbell-content':
    case 'fifthbell-marquee':
    case 'fifthbell-corner': {
      const supportsContent = componentType === 'fifthbell' || componentType === 'fifthbell-content';
      const supportsMarquee = componentType === 'fifthbell' || componentType === 'fifthbell-marquee';
      const selectedWeatherCities = Array.isArray(props.weatherCities) ? props.weatherCities.filter((c: unknown): c is string => typeof c === 'string') : [];
      const selectedCitySet = new Set(selectedWeatherCities);
      const languageRotation = Array.isArray(props.languageRotation)
        ? props.languageRotation.filter((l: unknown): l is string => typeof l === 'string')
        : ['en', 'es', 'en', 'it'];

      return (
        <div className='space-y-4'>
          <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showArticles, true)}
                  onChange={(e) => updateProp(componentType, 'showArticles', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Articles
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showWeather, true)}
                  onChange={(e) => updateProp(componentType, 'showWeather', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Weather
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showEarthquakes, true)}
                  onChange={(e) => updateProp(componentType, 'showEarthquakes', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Earthquakes
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showMarkets, true)}
                  onChange={(e) => updateProp(componentType, 'showMarkets', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Markets
              </label>
            )}
            {supportsMarquee && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showMarquee, false)}
                  onChange={(e) => updateProp(componentType, 'showMarquee', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Bottom Marquee
              </label>
            )}
            {supportsContent && (
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input
                  type='checkbox'
                  checked={toBoolean(props.showCallsignTake, true)}
                  onChange={(e) => updateProp(componentType, 'showCallsignTake', e.target.checked)}
                  className='h-4 w-4'
                />
                Show Callsign Take
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Data Load Timeout (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.dataLoadTimeoutMs ?? 15000}
                  onChange={(e) => updateProp(componentType, 'dataLoadTimeoutMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Articles Duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.articlesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'articlesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Weather Duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.weatherDurationMs ?? 5000}
                  onChange={(e) => updateProp(componentType, 'weatherDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Earthquakes Duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.earthquakesDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'earthquakesDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Markets Duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.marketsDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'marketsDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Playlist Default Duration (ms)</span>
                <Input
                  type='number'
                  min={1000}
                  value={props.playlistDefaultDurationMs ?? 10000}
                  onChange={(e) => updateProp(componentType, 'playlistDefaultDurationMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
            {supportsContent && (
              <label className='text-sm text-text-primary'>
                <span className='block text-xs text-text-secondary mb-1'>Playlist Update Interval (ms)</span>
                <Input
                  type='number'
                  min={50}
                  value={props.playlistUpdateIntervalMs ?? 100}
                  onChange={(e) => updateProp(componentType, 'playlistUpdateIntervalMs', Number(e.target.value))}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                />
              </label>
            )}
          </div>

          {supportsContent && (
            <div className='space-y-2'>
              <label className='block text-xs text-text-secondary'>Weather Cities</label>
              <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-1.5'>
                {FIFTHBELL_AVAILABLE_WEATHER_CITIES.map((city) => (
                  <label key={city} className='flex items-center gap-1.5 text-xs text-text-primary cursor-pointer'>
                    <Input
                      type='checkbox'
                      checked={selectedCitySet.has(city)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...selectedWeatherCities, city] : selectedWeatherCities.filter((c) => c !== city);
                        updateProp(componentType, 'weatherCities', next);
                      }}
                      className='h-3.5 w-3.5'
                    />
                    {city}
                  </label>
                ))}
              </div>
            </div>
          )}

          {supportsContent && (
            <div className='space-y-2'>
              <label className='block text-xs text-text-secondary'>Language Rotation (comma-separated)</label>
              <Input
                type='text'
                value={languageRotation.join(', ')}
                onChange={(e) =>
                  updateProp(
                    componentType,
                    'languageRotation',
                    e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  )
                }
                className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                placeholder='en, es, en, it'
              />
            </div>
          )}

          {supportsContent && (
            <details className='rounded border border-dashed border-sand/40 px-3 py-2'>
              <summary className='cursor-pointer text-xs font-medium text-text-secondary'>Advanced Timing</summary>
              <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-3'>
                <label className='flex items-center gap-2 text-sm text-text-primary'>
                  <Input
                    type='checkbox'
                    checked={toBoolean(props.audioCueEnabled, true)}
                    onChange={(e) => updateProp(componentType, 'audioCueEnabled', e.target.checked)}
                    className='h-4 w-4'
                  />
                  Audio Cue
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Cue Minute</span>
                  <Input
                    type='number'
                    min={0}
                    max={59}
                    value={props.audioCueMinute ?? 59}
                    onChange={(e) => updateProp(componentType, 'audioCueMinute', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Cue Second</span>
                  <Input
                    type='number'
                    min={0}
                    max={59}
                    value={props.audioCueSecond ?? 55}
                    onChange={(e) => updateProp(componentType, 'audioCueSecond', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Callsign Prelaunch</span>
                  <Input
                    type='text'
                    value={props.callsignPrelaunchUntilNyc ?? ''}
                    onChange={(e) => updateProp(componentType, 'callsignPrelaunchUntilNyc', e.target.value)}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                    placeholder='2026-01-02T21:30:00'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Callsign Window Start (s)</span>
                  <Input
                    type='number'
                    min={0}
                    max={59}
                    value={props.callsignWindowStartSecond ?? 50}
                    onChange={(e) => updateProp(componentType, 'callsignWindowStartSecond', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Callsign Window End (s)</span>
                  <Input
                    type='number'
                    min={0}
                    max={59}
                    value={props.callsignWindowEndSecond ?? 3}
                    onChange={(e) => updateProp(componentType, 'callsignWindowEndSecond', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
              </div>
            </details>
          )}

          {supportsMarquee && (
            <div className='space-y-3'>
              <p className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Marquee Settings</p>
              <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Min Posts Count</span>
                  <Input
                    type='number'
                    min={1}
                    value={props.marqueeMinPostsCount ?? 4}
                    onChange={(e) => updateProp(componentType, 'marqueeMinPostsCount', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Min Avg Relevance</span>
                  <Input
                    type='number'
                    min={0}
                    max={1}
                    step={0.01}
                    value={props.marqueeMinAverageRelevance ?? 0}
                    onChange={(e) => updateProp(componentType, 'marqueeMinAverageRelevance', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Min Median Relevance</span>
                  <Input
                    type='number'
                    min={0}
                    max={1}
                    step={0.01}
                    value={props.marqueeMinMedianRelevance ?? 0}
                    onChange={(e) => updateProp(componentType, 'marqueeMinMedianRelevance', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Pixels Per Second</span>
                  <Input
                    type='number'
                    min={1}
                    value={props.marqueePixelsPerSecond ?? 150}
                    onChange={(e) => updateProp(componentType, 'marqueePixelsPerSecond', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Min Duration (s)</span>
                  <Input
                    type='number'
                    min={1}
                    value={props.marqueeMinDurationSeconds ?? 10}
                    onChange={(e) => updateProp(componentType, 'marqueeMinDurationSeconds', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
                <label className='text-sm text-text-primary'>
                  <span className='block text-xs text-text-secondary mb-1'>Height (px)</span>
                  <Input
                    type='number'
                    min={20}
                    value={props.marqueeHeightPx ?? 72}
                    onChange={(e) => updateProp(componentType, 'marqueeHeightPx', Number(e.target.value))}
                    className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      );
    }
    case 'corner-bug':
      return <p className='text-xs text-text-secondary italic'>Corner bug has no configurable scene attributes.</p>;
    default:
      return <p className='text-xs text-text-secondary italic'>No editor available for &ldquo;{componentType}&rdquo;.</p>;
  }
}

export function ZIndexField({
  componentType,
  props,
  updateProp
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
}) {
  const zIndex = typeof props.zIndex === 'number' && Number.isFinite(props.zIndex) ? props.zIndex : 0;
  return (
    <div className='mt-3 flex items-center gap-3 border-t border-sand/20 pt-3'>
      <label className='text-xs text-text-secondary'>Z-Index</label>
      <Input
        type='number'
        value={zIndex}
        min={-100}
        max={100}
        onChange={(e) => updateProp(componentType, 'zIndex', Number(e.target.value))}
        className='w-24 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-sea/50'
      />
    </div>
  );
}
