import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SlideshowEditorFields } from './SlideshowEditorFields';
import { uploadFileToMediaBucket } from '../../services/uploads';
import type { MediaLabel } from '../../models/broadcast';

// gaulatti/alcantara#186: the slideshow scene editor.

vi.mock('../../services/uploads', () => ({ uploadFileToMediaBucket: vi.fn() }));
// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock('@gaulatti/bleecker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaulatti/bleecker')>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.mocked(uploadFileToMediaBucket).mockReset();
});

const TYPE = 'slideshow';
const asset = (id: string, mediaType: 'IMAGE' | 'VIDEO', sourceUrl: string) => ({
  position: 0,
  asset: { id, mediaType, name: id, sourceUrl },
});
const labels: MediaLabel[] = [
  {
    id: 'skyline',
    name: 'Skyline',
    description: null,
    assetCount: 3,
    assets: [
      asset('a', 'IMAGE', 'https://media.example.test/a.jpg'),
      asset('b', 'VIDEO', 'https://media.example.test/b.mp4'),
      asset('c', 'IMAGE', ''),
    ],
  },
  { id: 'legacy-media-group:4', name: 'Old group', description: null, assetCount: 0, assets: [] },
];

function editor(props: Record<string, unknown>, mediaLabels: MediaLabel[] = labels, isLoadingMediaLabels = false) {
  const updateProp = vi.fn();
  render(
    <SlideshowEditorFields
      componentType={TYPE}
      props={props}
      updateProp={updateProp}
      mediaLabels={mediaLabels}
      isLoadingMediaLabels={isLoadingMediaLabels}
    />,
  );
  return updateProp;
}

const [interval, transition] = [() => screen.getAllByRole('spinbutton')[0], () => screen.getAllByRole('spinbutton')[1]];

it('edits timing with its minimums and defaults, the fit mode and the motion switches', () => {
  const updateProp = editor({});
  expect(interval()).toHaveValue(5000);
  expect(transition()).toHaveValue(900);
  expect(screen.getByRole('checkbox', { name: 'Shuffle' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Ken Burns Motion' })).toBeChecked();
  fireEvent.change(interval(), { target: { value: '200' } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'intervalMs', 1000);
  fireEvent.change(interval(), { target: { value: '' } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'intervalMs', 5000);
  fireEvent.change(transition(), { target: { value: '50' } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'transitionMs', 100);
  fireEvent.change(transition(), { target: { value: '' } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'transitionMs', 900);
  const fit = screen.getAllByRole('combobox')[0];
  expect(fit).toHaveValue('cover');
  fireEvent.change(fit, { target: { value: 'contain' } });
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'fitMode', 'contain');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Shuffle' }));
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'shuffle', true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ken Burns Motion' }));
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'kenBurns', false);
});

it('reads saved settings, including switches stored as strings or numbers', () => {
  const cases: [unknown, unknown, boolean, boolean][] = [
    ['Yes', 0, true, false],
    [' off ', 'on', false, true],
    [1, 'maybe', true, true],
    [{}, '', false, false],
    [true, false, true, false],
  ];
  for (const [shuffle, kenBurns, shuffled, moving] of cases) {
    editor({ shuffle, kenBurns, intervalMs: 8000, transitionMs: 400, fitMode: 'contain' });
    expect((screen.getByRole('checkbox', { name: 'Shuffle' }) as HTMLInputElement).checked).toBe(shuffled);
    expect((screen.getByRole('checkbox', { name: 'Ken Burns Motion' }) as HTMLInputElement).checked).toBe(moving);
    expect(interval()).toHaveValue(8000);
    expect(transition()).toHaveValue(400);
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('contain');
    cleanup();
  }
});

it('uploads images in order and removes one, reporting partial and total failures', async () => {
  const updateProp = editor({ images: ['https://media.example.test/kept.jpg'] });
  expect(screen.getByAltText('Slideshow 1')).toHaveAttribute('src', 'https://media.example.test/kept.jpg');
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  vi.mocked(uploadFileToMediaBucket)
    .mockResolvedValueOnce({ key: 'k', url: 'https://media.example.test/new.jpg', bucket: 'b', contentType: 'image/jpeg', sizeBytes: 1 })
    .mockRejectedValueOnce(new Error('too big'));
  let finish!: () => void;
  vi.mocked(uploadFileToMediaBucket).mockImplementationOnce(
    () => new Promise((_done, fail) => (finish = () => fail(new Error('offline')))),
  );
  const files = ['one', 'two', 'three'].map((name) => new File(['x'], `${name}.jpg`, { type: 'image/jpeg' }));
  fireEvent.change(input, { target: { files } });
  expect(await screen.findByText('Uploading image...')).toBeInTheDocument();
  expect(input).toBeDisabled();
  await act(async () => finish());
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'images', [
    'https://media.example.test/kept.jpg',
    'https://media.example.test/new.jpg',
  ]);
  expect(screen.getByText('Uploaded 1 of 3 images.')).toBeInTheDocument();

  vi.mocked(uploadFileToMediaBucket).mockRejectedValue(new Error('offline'));
  await act(async () => {
    fireEvent.change(input, { target: { files: [files[0]] } });
  });
  expect(screen.getByText('Failed to upload selected image files.')).toBeInTheDocument();

  fireEvent.change(input, { target: { files: [] } });
  fireEvent.change(input, { target: { files: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'images', []);
});

it('follows a label, showing only its images, and clears the legacy media group', () => {
  const updateProp = editor({ labelId: 'skyline', images: ['https://media.example.test/kept.jpg'] });
  expect(screen.getByText('Using label "Skyline"')).toBeInTheDocument();
  expect(screen.getByText('This slideshow follows the selected label in its saved order.')).toBeInTheDocument();
  expect(screen.getAllByAltText(/^Labeled image/).map((image) => image.getAttribute('src'))).toEqual([
    'https://media.example.test/a.jpg',
  ]);
  expect(screen.queryByAltText('Slideshow 1')).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
  const picker = screen.getAllByRole('combobox')[1];
  expect(within(picker).getByRole('option', { name: 'Skyline (2 images)' })).toBeInTheDocument();
  fireEvent.change(picker, { target: { value: '' } });
  expect(updateProp).toHaveBeenCalledWith(TYPE, 'labelId', null);
  expect(updateProp).toHaveBeenCalledWith(TYPE, 'mediaGroupId', null);
});

it('maps a legacy media group to its label, and says when a label is missing or empty', () => {
  editor({ mediaGroupId: 4 });
  expect(screen.getByText('Using label "Old group"')).toBeInTheDocument();
  expect(screen.getByText('No images have this label yet.')).toBeInTheDocument();
  cleanup();
  editor({ labelId: 'deleted' }, labels, true);
  expect(screen.getByText('Selected label not found.')).toBeInTheDocument();
  expect(screen.getByText('No images have this label yet.')).toBeInTheDocument();
  expect(screen.getByText('Loading labels...')).toBeInTheDocument();
  cleanup();
  editor({});
  expect(screen.getByText('Select a label to reuse the same images across scenes.')).toBeInTheDocument();
});

it('reports no upload error when every selected image uploads', async () => {
  const updateProp = editor({ images: [] });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue({ key: 'k', url: 'https://media.example.test/all.jpg', bucket: 'b', contentType: 'image/jpeg', sizeBytes: 1 });
  const files = ['one', 'two'].map((name) => new File(['x'], `${name}.jpg`, { type: 'image/jpeg' }));
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(updateProp).toHaveBeenLastCalledWith(TYPE, 'images', [
    'https://media.example.test/all.jpg',
    'https://media.example.test/all.jpg',
  ]));
  expect(screen.queryByText(/Failed to upload|Uploaded \d+ of/)).toBeNull();
});
