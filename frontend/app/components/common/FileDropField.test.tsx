import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileDropField } from './FileDropField';
import { uploadFileToMediaBucket } from '../../services/uploads';

// gaulatti/alcantara#186: the click-or-drop media upload field.

vi.mock('../../services/uploads', () => ({ uploadFileToMediaBucket: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(uploadFileToMediaBucket).mockReset();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;
const file = (bytes: number, name = 'clip.mp3') => new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });
const uploaded = (url: string) => ({ key: 'k', url, bucket: 'media', contentType: 'audio/mpeg', sizeBytes: 1 });

function field(overrides: Partial<Parameters<typeof FileDropField>[0]> = {}) {
  const onUploaded = vi.fn();
  render(
    <FileDropField kind='instant' accept='audio/*' maxBytes={2 * MB} label='Drop a clip' onUploaded={onUploaded} {...overrides} />,
  );
  return {
    onUploaded,
    zone: screen.getByRole('button', { name: 'Drop a clip' }),
    input: screen.getByTestId('file-drop-input') as HTMLInputElement,
  };
}

it('uploads a chosen file and reports its URL', async () => {
  vi.mocked(uploadFileToMediaBucket).mockResolvedValue(uploaded('https://media.example.test/clip.mp3'));
  const { onUploaded, input } = field();
  const chosen = file(10);
  await act(async () => {
    fireEvent.change(input, { target: { files: [chosen] } });
  });
  expect(uploadFileToMediaBucket).toHaveBeenCalledWith('instant', chosen);
  expect(onUploaded).toHaveBeenCalledWith('https://media.example.test/clip.mp3', chosen);
  expect(input.accept).toBe('audio/*');
});

it('uploads a dropped file, highlighting the zone while dragging', async () => {
  let finish!: (value: ReturnType<typeof uploaded>) => void;
  vi.mocked(uploadFileToMediaBucket).mockReturnValue(new Promise((done) => (finish = done)));
  const { onUploaded, zone, input } = field();
  fireEvent.dragOver(zone);
  expect(zone.className).toContain('border-sea bg-sea/10');
  fireEvent.dragLeave(zone);
  expect(zone.className).not.toContain('bg-sea/10');
  fireEvent.dragOver(zone);
  const dropped = file(10);
  fireEvent.drop(zone, { dataTransfer: { files: [dropped] } });
  expect(zone.className).not.toContain('bg-sea/10');
  expect(zone).toHaveTextContent('Uploading…');
  expect(zone).toHaveAttribute('aria-disabled', 'true');
  expect(input).toBeDisabled();
  // A second drop while uploading is ignored.
  fireEvent.drop(zone, { dataTransfer: { files: [file(10, 'other.mp3')] } });
  expect(uploadFileToMediaBucket).toHaveBeenCalledTimes(1);
  await act(async () => finish(uploaded('https://media.example.test/clip.mp3')));
  expect(onUploaded).toHaveBeenCalledWith('https://media.example.test/clip.mp3', dropped);
  expect(zone).toHaveTextContent('Drop a clip');
});

it('refuses a file over the size limit before uploading', () => {
  const { input } = field();
  fireEvent.change(input, { target: { files: [file(2 * MB + 1)] } });
  expect(screen.getByRole('alert')).toHaveTextContent('File too large. Max size is 2MB');
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();
});

it('reports an upload failure with its reason, or a fallback', async () => {
  const { input } = field();
  for (const [failure, message] of [
    [new Error('Quota reached'), 'Quota reached'],
    [new Error(''), 'Upload failed'],
    ['offline', 'Upload failed'],
  ] as const) {
    vi.mocked(uploadFileToMediaBucket).mockRejectedValueOnce(failure);
    await act(async () => {
      fireEvent.change(input, { target: { files: [file(10)] } });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  }
});

it('opens the file picker by click, Enter or Space, and ignores other keys and empty drops', () => {
  const { zone, input } = field();
  const pick = vi.spyOn(input, 'click');
  fireEvent.click(zone);
  fireEvent.keyDown(zone, { key: 'Enter' });
  fireEvent.keyDown(zone, { key: ' ' });
  fireEvent.keyDown(zone, { key: 'a' });
  expect(pick).toHaveBeenCalledTimes(3);
  expect(zone).toHaveAttribute('tabindex', '0');
  fireEvent.drop(zone, { dataTransfer: { files: [] } });
  fireEvent.drop(zone, { dataTransfer: {} });
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();
});

it('takes no file while disabled', () => {
  const { zone, input } = field({ disabled: true });
  expect(zone).toHaveAttribute('tabindex', '-1');
  expect(zone).toHaveAttribute('aria-disabled', 'true');
  expect(zone.className).toContain('pointer-events-none');
  expect(input).toBeDisabled();
  fireEvent.drop(zone, { dataTransfer: { files: [file(10)] } });
  expect(uploadFileToMediaBucket).not.toHaveBeenCalled();
});

it('finishes an upload after the field has gone, without touching the removed input', async () => {
  let finish!: (value: ReturnType<typeof uploaded>) => void;
  vi.mocked(uploadFileToMediaBucket).mockReturnValue(new Promise((done) => (finish = done)));
  const { zone, onUploaded } = field();
  fireEvent.drop(zone, { dataTransfer: { files: [file(10)] } });
  expect(zone).toHaveTextContent('Uploading…');
  cleanup();
  await act(async () => finish(uploaded('https://media.example.test/clip.mp3')));
  expect(onUploaded).toHaveBeenCalledWith('https://media.example.test/clip.mp3', expect.any(File));
});
