import { useState } from 'react';
import { Button, Input, Select } from '@gaulatti/bleecker';
import { uploadFileToMediaBucket } from '../../services/uploads';
import { normalizeSlideshowImageList, normalizeSlideshowLabelId, normalizeSlideshowMediaGroupId } from '../../utils/broadcast';
import type { MediaLabel } from '../../models/broadcast';
import { SearchableSelect } from './SearchableSelect';

export function SlideshowEditorFields({
  componentType,
  props,
  updateProp,
  mediaLabels,
  isLoadingMediaLabels
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  mediaLabels: MediaLabel[];
  isLoadingMediaLabels: boolean;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const images = normalizeSlideshowImageList(props.images);
  const asBoolean = (value: unknown, fallback: boolean) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const n = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(n)) return true;
      if (['false', '0', 'no', 'off', ''].includes(n)) return false;
    }
    return fallback;
  };
  const setImages = (nextImages: string[]) => updateProp(componentType, 'images', nextImages);
  const legacyMediaGroupId = normalizeSlideshowMediaGroupId(props.mediaGroupId);
  const selectedLabelId = normalizeSlideshowLabelId(props.labelId) ?? (legacyMediaGroupId === null ? null : `legacy-media-group:${legacyMediaGroupId}`);
  const selectedLabel = selectedLabelId !== null ? (mediaLabels.find(label => label.id === selectedLabelId) ?? null) : null;
  const labeledImages = selectedLabel
    ? selectedLabel.assets.filter(item => item.asset.mediaType === 'IMAGE').map(item => item.asset.sourceUrl).filter(Boolean)
    : [];
  const usesLabel = selectedLabelId !== null;

  const selectLabel = (value: string) => {
    updateProp(componentType, 'labelId', normalizeSlideshowLabelId(value));
    updateProp(componentType, 'mediaGroupId', null);
  };

  const uploadImages = async (files: File[]) => {
    if (!files.length) return;
    setUploadError('');
    setIsUploading(true);
    const nextImages = [...images];
    let failed = 0;
    try {
      for (const file of files) {
        try { nextImages.push((await uploadFileToMediaBucket('artwork', file)).url); }
        catch { failed += 1; }
      }
      setImages(nextImages);
      if (failed > 0) setUploadError(failed === files.length ? 'Failed to upload selected image files.' : `Uploaded ${files.length - failed} of ${files.length} images.`);
    } finally { setIsUploading(false); }
  };

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Interval (ms)</span>
          <Input type='number' min={1000} step={100}
            value={typeof props.intervalMs === 'number' ? props.intervalMs : 5000}
            onChange={e => updateProp(componentType, 'intervalMs', Math.max(1000, Number(e.target.value) || 5000))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50' />
        </label>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Transition (ms)</span>
          <Input type='number' min={100} step={50}
            value={typeof props.transitionMs === 'number' ? props.transitionMs : 900}
            onChange={e => updateProp(componentType, 'transitionMs', Math.max(100, Number(e.target.value) || 900))}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50' />
        </label>
        <label className='text-sm text-text-primary'>
          <span className='block text-xs text-text-secondary mb-1'>Fit Mode</span>
          <Select value={props.fitMode === 'contain' ? 'contain' : 'cover'}
            onChange={v => updateProp(componentType, 'fitMode', v)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50'
            options={[{ value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }]} />
        </label>
        <div className='flex flex-col justify-end gap-2 pb-1'>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input type='checkbox' checked={asBoolean(props.shuffle, false)}
              onChange={e => updateProp(componentType, 'shuffle', e.target.checked)} className='h-4 w-4' />
            Shuffle
          </label>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input type='checkbox' checked={asBoolean(props.kenBurns, true)}
              onChange={e => updateProp(componentType, 'kenBurns', e.target.checked)} className='h-4 w-4' />
            Ken Burns Motion
          </label>
        </div>
      </div>

      <div className='space-y-2'>
        <label className='block text-xs text-text-secondary'>Image label</label>
        <SearchableSelect value={selectedLabelId ?? ''}
          onChange={selectLabel}
          className='w-full rounded border border-sand/40 px-3 py-2 text-sm focus:ring-2 focus:ring-sea/50'
          searchPlaceholder='Search labels…'
          options={[
            { value: '', label: 'Manual images in scene metadata' },
            ...mediaLabels.map(label => ({
              value: label.id,
              label: `${label.name} (${label.assets.filter(item => item.asset.mediaType === 'IMAGE').length} images)`
            }))
          ]} />
        <p className='text-xs text-text-secondary'>
          {isLoadingMediaLabels ? 'Loading labels...' : usesLabel ? 'This slideshow follows the selected label in its saved order.' : 'Select a label to reuse the same images across scenes.'}
        </p>
      </div>

      {!usesLabel ? (
        <div className='space-y-2'>
          <label className='block text-xs text-text-secondary'>Upload images</label>
          <Input type='file' accept='image/*' multiple disabled={isUploading}
            onChange={e => { const files = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; void uploadImages(files); }}
            className='block w-full text-xs text-text-secondary file:mr-3 file:rounded file:border file:border-sand/40 file:bg-dark-sand/80 file:px-2 file:py-1 file:text-xs file:font-medium file:text-text-primary hover:file:bg-sand/10' />
          <p className='text-xs text-text-secondary mt-1'>1920x1080 images are recommended. Upload one or many files.</p>
          {isUploading ? <p className='text-xs text-text-secondary'>Uploading image...</p> : null}
          {uploadError ? <p className='text-xs text-terracotta'>{uploadError}</p> : null}
        </div>
      ) : null}

      {usesLabel ? (
        <div className='space-y-2'>
          <p className='text-xs text-text-secondary'>{selectedLabel ? `Using label "${selectedLabel.name}"` : 'Selected label not found.'}</p>
          {selectedLabel && labeledImages.length > 0 ? (
            <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
              {labeledImages.map((url, i) => (
                <div key={`${url}_${i}`} className='rounded border border-sand/30 bg-dark-sand/80 p-2'>
                  <img src={url} alt={`Labeled image ${i + 1}`} className='h-20 w-full rounded object-cover bg-sand/10' />
                </div>
              ))}
            </div>
          ) : <p className='text-xs text-text-secondary'>No images have this label yet.</p>}
        </div>
      ) : images.length > 0 ? (
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2'>
          {images.map((url, i) => (
            <div key={`${url}_${i}`} className='rounded border border-sand/30 bg-dark-sand/80 p-2 space-y-2'>
              <img src={url} alt={`Slideshow ${i + 1}`} className='h-20 w-full rounded object-cover bg-sand/10' />
              <Button type='button' onClick={() => setImages(images.filter((_, idx) => idx !== i))}
                className='w-full rounded border border-terracotta/35 px-2 py-1 text-xs font-medium text-terracotta hover:bg-terracotta/10'>Remove</Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
