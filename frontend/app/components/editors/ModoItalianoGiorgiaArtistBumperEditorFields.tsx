import React from 'react';
import { Checkbox, Field, Input } from '@gaulatti/bleecker';
import type { MediaLabel } from '../../models/broadcast';
import { FileDropField } from '../common/FileDropField';
import { describeArtistBumperProblem, normalizeArtistBumperLabelId, pickArtistBumperLabelImages } from '../ModoItalianoGiorgiaArtistBumper';
import { SearchableSelect } from './SearchableSelect';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_SLOTS = [0, 1, 2, 3] as const;
const IMAGE_ROLES = ['First cut', 'Second cut', 'Third cut', 'Behind the artist name'];

export function ModoItalianoGiorgiaArtistBumperEditorFields({
  componentType,
  props,
  updateProp,
  mediaLabels,
  isLoadingMediaLabels
}: {
  componentType: string;
  props: {
    show?: boolean;
    artist?: string;
    songTitle?: string;
    labelId?: unknown;
    images?: unknown;
    contentType?: string;
    creditLines?: unknown;
  };
  updateProp: (componentType: string, propName: string, value: any) => void;
  mediaLabels: MediaLabel[];
  isLoadingMediaLabels: boolean;
}) {
  const images = IMAGE_SLOTS.map((slot) => (Array.isArray(props.images) && typeof props.images[slot] === 'string' ? (props.images[slot] as string) : ''));
  const credits = [0, 1].map((slot) => (Array.isArray(props.creditLines) && typeof props.creditLines[slot] === 'string' ? (props.creditLines[slot] as string) : ''));
  const setImage = (slot: number, url: string) => updateProp(componentType, 'images', images.map((current, index) => (index === slot ? url : current)));
  const setCredit = (slot: number, line: string) => updateProp(componentType, 'creditLines', credits.map((current, index) => (index === slot ? line : current)));
  const textField = (label: string, propName: 'artist' | 'songTitle' | 'contentType', placeholder: string) => (
    <Field label={label}>
      <Input type='text' value={props[propName] || ''} onChange={(e) => updateProp(componentType, propName, e.target.value)} placeholder={placeholder} />
    </Field>
  );
  const labelImageUrls = (label: MediaLabel) =>
    [...label.assets]
      .sort((left, right) => left.position - right.position)
      .filter((item) => item.asset.mediaType === 'IMAGE')
      .map((item) => item.asset.sourceUrl)
      .filter(Boolean);
  const selectedLabelId = normalizeArtistBumperLabelId(props.labelId);
  const selectedLabel = selectedLabelId ? (mediaLabels.find((label) => label.id === selectedLabelId) ?? null) : null;
  const selectedLabelUrls = selectedLabel ? labelImageUrls(selectedLabel) : [];
  const pickedLabelImages = pickArtistBumperLabelImages(selectedLabelUrls);
  // Until the labels have loaded, a saved label cannot be judged, so no warning is shown for it.
  const problem = selectedLabelId && !selectedLabel ? describeArtistBumperProblem({ ...props, labelId: null, images: ['-', '--', '---', '----'] }) : describeArtistBumperProblem(props, selectedLabelUrls);

  return (
    <div className='space-y-4'>
      <label className='flex items-center gap-2 text-sm text-text-primary'>
        <Checkbox checked={typeof props.show === 'boolean' ? props.show : true} onChange={(e) => updateProp(componentType, 'show', e.target.checked)} />
        Show bumper
      </label>
      <p className='text-xs text-text-secondary'>
        Plays Giorgia&apos;s 12-second artist bumper once, silent, then holds its &ldquo;In onda ora&rdquo; card. It restarts when shown again or when its content
        changes.
      </p>
      {problem ? (
        <p role='status' className='text-xs text-text-secondary'>
          Nothing plays yet. {problem}
        </p>
      ) : null}

      {textField('Artist', 'artist', 'ROB')}
      {textField('Song title', 'songTitle', 'Cento ragazze')}

      <div className='space-y-2'>
        <label className='block text-xs text-text-secondary'>Image label</label>
        <SearchableSelect
          value={selectedLabelId ?? ''}
          onChange={(value) => updateProp(componentType, 'labelId', normalizeArtistBumperLabelId(value))}
          searchPlaceholder='Search labels…'
          options={[
            { value: '', label: 'Four images set by hand' },
            ...mediaLabels.map((label) => ({ value: label.id, label: `${label.name} (${labelImageUrls(label).length} images)` }))
          ]}
        />
        <p className='text-xs text-text-secondary'>
          {isLoadingMediaLabels
            ? 'Loading labels...'
            : selectedLabelId
              ? 'The bumper uses the first four different images of this label, in its saved order.'
              : 'Select a label to take the four images from it.'}
        </p>
        {pickedLabelImages ? (
          <div className='flex gap-2'>
            {pickedLabelImages.map((url, index) => (
              <img key={url} src={url} alt={`Label image ${index + 1}`} className='h-12 w-20 border border-sand/30 object-cover' />
            ))}
          </div>
        ) : null}
      </div>

      {!selectedLabelId ? (
        <>
        {IMAGE_SLOTS.map((slot) => (
          <div key={slot} className='space-y-2'>
            <label className='block text-xs text-text-secondary'>
              Image {slot + 1} · {IMAGE_ROLES[slot]} (16:9)
            </label>
            {images[slot] ? <img src={images[slot]} alt={`Bumper image ${slot + 1}`} className='h-16 w-28 border border-sand/30 object-cover' /> : null}
            <FileDropField
              kind='artwork'
              accept='image/*'
              maxBytes={MAX_IMAGE_BYTES}
              label={`Drop image ${slot + 1} or click to upload (max 10MB)`}
              onUploaded={(url) => setImage(slot, url)}
            />
            <Input
              type='text'
              aria-label={`Image ${slot + 1} URL`}
              value={images[slot]}
              onChange={(e) => setImage(slot, e.target.value)}
              placeholder='…or paste a URL: https://example.com/image.jpg'
            />
          </div>
        ))}
        </>
      ) : null}

      {textField('Content type (optional)', 'contentType', 'Singolo')}
      {[0, 1].map((slot) => (
        <Field key={slot} label={`Credit line ${slot + 1} (optional)`}>
          <Input
            type='text'
            value={credits[slot]}
            onChange={(e) => setCredit(slot, e.target.value)}
            placeholder={slot === 0 ? 'Warner Music Italy · 2025' : 'Inedito di X Factor 2025'}
          />
        </Field>
      ))}
    </div>
  );
}
