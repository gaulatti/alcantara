import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SongIntroField } from './SongIntroField';
import type { InstantItem } from '../../models/broadcast';

// gaulatti/alcantara#186: choosing and previewing a song's intro clip.

afterEach(cleanup);

const clip = (id: number, overrides: Partial<InstantItem> = {}): InstantItem => ({
  id,
  name: `Intro ${id}`,
  audioUrl: `https://media.example.test/intro-${id}.mp3`,
  volume: 1,
  enabled: true,
  position: id,
  ...overrides,
});

const instants = [
  clip(1),
  clip(2, { enabled: false }),
  clip(3, { availableForSongIntro: false, assignedSongId: 77 }),
  clip(4, { availableForSongIntro: false, assignedSongId: 9 }),
];

it('offers enabled intros, including one already assigned to this song, and previews the choice', () => {
  const onChange = vi.fn();
  const onPreview = vi.fn();
  render(
    <SongIntroField
      instants={instants}
      songId={9}
      selectedInstantId='4'
      onChange={onChange}
      onPreview={onPreview}
    />,
  );
  expect(screen.getByRole('option', { name: 'Intro 1' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Intro 2 — unavailable' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Intro 3 — unavailable' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Intro 4' })).toBeEnabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Assigned song intro' }), {
    target: { value: '1' },
  });
  expect(onChange).toHaveBeenCalledWith('1');
  fireEvent.click(screen.getByRole('button', { name: 'Preview intro' }));
  expect(onPreview).toHaveBeenCalledWith(instants[3]);
  expect(screen.queryByText(/Saving removes/)).toBeNull();
});

it('cannot preview without a choice or while previewing, and warns before removing an intro', () => {
  const { rerender } = render(
    <SongIntroField
      instants={instants}
      currentIntroInstantId={1}
      selectedInstantId=''
      validationError='Choose an enabled intro.'
      onChange={vi.fn()}
      onPreview={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Preview intro' })).toBeDisabled();
  expect(screen.getByText('Saving removes the current song intro assignment.')).toBeInTheDocument();
  expect(screen.getByText('Choose an enabled intro.')).toBeInTheDocument();
  rerender(
    <SongIntroField instants={instants} selectedInstantId='1' previewing onChange={vi.fn()} onPreview={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'Previewing…' })).toBeDisabled();
});
