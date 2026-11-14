import React from 'react';
import { Checkbox, Field, Input } from '@gaulatti/bleecker';
import { FileDropField } from '../common/FileDropField';
import { describeArtistBumperProblem } from '../ModoItalianoGiorgiaArtistBumper';

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_SLOTS = [0, 1, 2, 3] as const;
const IMAGE_ROLES = ['First cut', 'Second cut', 'Third cut', 'Behind the artist name'];

export function ModoItalianoGiorgiaArtistBumperEditorFields({
  componentType,
  props,
  updateProp
}: {
  componentType: string;
  props: {
    show?: boolean;
    artist?: string;
    songTitle?: string;
    images?: unknown;
    audioUrl?: string;
    eyebrow?: string;
    contentType?: string;
    creditLines?: unknown;
    siteUrl?: string;
  };
  updateProp: (componentType: string, propName: string, value: any) => void;
}) {
  const images = IMAGE_SLOTS.map((slot) => (Array.isArray(props.images) && typeof props.images[slot] === 'string' ? (props.images[slot] as string) : ''));
  const credits = [0, 1].map((slot) => (Array.isArray(props.creditLines) && typeof props.creditLines[slot] === 'string' ? (props.creditLines[slot] as string) : ''));
  const setImage = (slot: number, url: string) => updateProp(componentType, 'images', images.map((current, index) => (index === slot ? url : current)));
  const setCredit = (slot: number, line: string) => updateProp(componentType, 'creditLines', credits.map((current, index) => (index === slot ? line : current)));
  const textField = (label: string, propName: 'artist' | 'songTitle' | 'eyebrow' | 'contentType' | 'siteUrl', placeholder: string) => (
    <Field label={label}>
      <Input type='text' value={props[propName] || ''} onChange={(e) => updateProp(componentType, propName, e.target.value)} placeholder={placeholder} />
    </Field>
  );
  const problem = describeArtistBumperProblem(props);

  return (
    <div className='space-y-4'>
      <label className='flex items-center gap-2 text-sm text-text-primary'>
        <Checkbox checked={typeof props.show === 'boolean' ? props.show : true} onChange={(e) => updateProp(componentType, 'show', e.target.checked)} />
        Show bumper
      </label>
      <p className='text-xs text-text-secondary'>
        Plays Giorgia&apos;s 12-second artist bumper once, then holds its &ldquo;In onda ora&rdquo; card. It restarts when shown again or when its content
        changes.
      </p>
      {problem ? (
        <p role='status' className='text-xs text-text-secondary'>
          Nothing plays yet. {problem}
        </p>
      ) : null}

      {textField('Artist', 'artist', 'ROB')}
      {textField('Song title', 'songTitle', 'Cento ragazze')}

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

      <div className='space-y-2'>
        <label className='block text-xs text-text-secondary'>Audio (optional)</label>
        <FileDropField
          kind='instant'
          accept='audio/*,.mp3,.aac,.m4a,.wav,.flac,.ogg,.webm'
          maxBytes={MAX_AUDIO_BYTES}
          label='Drop an audio file or click to upload (max 200MB)'
          onUploaded={(url) => updateProp(componentType, 'audioUrl', url)}
        />
        <Input
          type='text'
          aria-label='Audio URL'
          value={props.audioUrl || ''}
          onChange={(e) => updateProp(componentType, 'audioUrl', e.target.value)}
          placeholder='…or paste a URL: https://example.com/bumper.mp3'
        />
      </div>

      {textField('Eyebrow (optional)', 'eyebrow', 'ModoItaliano presenta')}
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
      {textField('Site address (optional)', 'siteUrl', 'modoitaliano.fm')}
    </div>
  );
}
