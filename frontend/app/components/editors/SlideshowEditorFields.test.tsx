import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlideshowEditorFields } from './SlideshowEditorFields';
import type { MediaLabel } from '../../models/broadcast';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../../services/uploads', () => ({ uploadFileToMediaBucket: upload }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function editor(props: Record<string, unknown> = {}, mediaLabels: MediaLabel[] = [], loading = false) {
  const updateProp = vi.fn();
  const rendered = render(<SlideshowEditorFields componentType="slideshow" props={props} updateProp={updateProp} mediaLabels={mediaLabels} isLoadingMediaLabels={loading} />);
  return { ...rendered, updateProp };
}

describe('slideshow editorial fields', () => {
  it('normalizes manual images and removes only the chosen image', () => {
    const { updateProp } = editor({ images: 'https://media.example/a.jpg,https://media.example/b.jpg\nhttps://media.example/a.jpg' });
    expect(screen.getAllByRole('img')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(updateProp).toHaveBeenCalledWith('slideshow', 'images', ['https://media.example/b.jpg']);
  });
  it('enforces timing bounds and existing defaults at the operator input boundary', () => {
    const { updateProp } = editor({ intervalMs: 6000, transitionMs: 1200 });
    const interval = screen.getByLabelText('Interval (ms)');
    const transition = screen.getByLabelText('Transition (ms)');
    expect(interval).toHaveValue(6000);
    expect(transition).toHaveValue(1200);
    fireEvent.change(interval, { target: { value: '10' } });
    expect(updateProp).toHaveBeenLastCalledWith('slideshow', 'intervalMs', 1000);
    fireEvent.change(interval, { target: { value: '' } });
    expect(updateProp).toHaveBeenLastCalledWith('slideshow', 'intervalMs', 5000);
    fireEvent.change(transition, { target: { value: '10' } });
    expect(updateProp).toHaveBeenLastCalledWith('slideshow', 'transitionMs', 100);
    fireEvent.change(transition, { target: { value: '' } });
    expect(updateProp).toHaveBeenLastCalledWith('slideshow', 'transitionMs', 900);
  });
  it.each([
    [true, true], [false, false], [1, true], [0, false],
    [' YES ', true], ['off', false], ['bad', false], [null, false],
  ])('interprets saved shuffle value %j without changing other properties', (shuffle, checked) => {
    const { updateProp } = editor({ shuffle });
    expect(screen.getByLabelText('Shuffle')).toHaveProperty('checked', checked);
    expect(screen.getByLabelText('Ken Burns Motion')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Shuffle'));
    expect(updateProp).toHaveBeenCalledWith('slideshow', 'shuffle', !checked);
    fireEvent.click(screen.getByLabelText('Ken Burns Motion'));
    expect(updateProp).toHaveBeenLastCalledWith('slideshow', 'kenBurns', false);
  });
  it('reports label loading and preserves legacy label identity', () => {
    const legacy: MediaLabel = { id: 'legacy-media-group:7', name: 'Legacy stills', description: null, assetCount: 0, assets: [] };
    editor({ mediaGroupId: 7 }, [legacy], true);
    expect(screen.getByText('Loading labels...')).toBeInTheDocument();
    expect(screen.getByText('Using label "Legacy stills"')).toBeInTheDocument();
    expect(screen.getByText('No images have this label yet.')).toBeInTheDocument();
    expect(screen.queryByText('Upload images')).not.toBeInTheDocument();
  });
  it('shows only label-owned image URLs and makes missing labels explicit', () => {
    const label: MediaLabel = { id: 'stills', name: 'Show stills', description: null, assetCount: 3, assets: [
      { position: 0, asset: { id: 'one', mediaType: 'IMAGE', name: 'Still', sourceUrl: 'https://media.example/one.jpg' } },
      { position: 1, asset: { id: 'song', mediaType: 'AUDIO', name: 'Song', sourceUrl: 'https://media.example/song.mp3' } },
      { position: 2, asset: { id: 'empty', mediaType: 'IMAGE', name: 'Unavailable image', sourceUrl: '' } },
    ] };
    const view = editor({ labelId: 'stills' }, [label]);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByAltText('Labeled image 1')).toHaveAttribute('src', 'https://media.example/one.jpg');
    view.unmount();
    editor({ labelId: 'missing' }, [label]);
    expect(screen.getByText('Selected label not found.')).toBeInTheDocument();
    expect(screen.getByText('No images have this label yet.')).toBeInTheDocument();
  });
});

describe('slideshow media uploads', () => {
  it('appends successful uploads and disables the input while work is in flight', async () => {
    let finish!: (value: { url: string }) => void;
    upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const file = new File(['fictional image'], 'still.jpg', { type: 'image/jpeg' });
    const { container, updateProp } = editor({ images: ['https://media.example/existing.jpg'] });
    const input = container.querySelector('input[type=file]')!;
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('Uploading image...')).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(upload).toHaveBeenCalledWith('artwork', file);
    await act(async () => finish({ url: 'https://media.example/new.jpg' }));
    expect(input).not.toBeDisabled();
    expect(updateProp).toHaveBeenCalledWith('slideshow', 'images', ['https://media.example/existing.jpg', 'https://media.example/new.jpg']);
  });
  it('retains successful files and clearly reports a partial upload failure', async () => {
    upload.mockResolvedValueOnce({ url: 'https://media.example/new.jpg' }).mockRejectedValueOnce(new Error('upload failed'));
    const { container, updateProp } = editor();
    await act(async () => fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.jpg'), new File(['b'], 'b.jpg')] } }));
    expect(screen.getByText('Uploaded 1 of 2 images.')).toBeInTheDocument();
    expect(updateProp).toHaveBeenCalledWith('slideshow', 'images', ['https://media.example/new.jpg']);
  });
  it('preserves existing images and reports a complete upload failure', async () => {
    upload.mockRejectedValue(new Error('upload failed'));
    const { container, updateProp } = editor({ images: ['https://media.example/existing.jpg'] });
    await act(async () => fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'a.jpg')] } }));
    expect(screen.getByText('Failed to upload selected image files.')).toBeInTheDocument();
    expect(updateProp).toHaveBeenCalledWith('slideshow', 'images', ['https://media.example/existing.jpg']);
  });
  it('does not start an upload for an empty file selection', () => {
    const { container, updateProp } = editor();
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: null } });
    expect(upload).not.toHaveBeenCalled();
    expect(updateProp).not.toHaveBeenCalled();
  });
});
