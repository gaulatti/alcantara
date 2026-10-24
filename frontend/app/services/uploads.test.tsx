import { afterEach, expect, it, vi } from 'vitest';
import { uploadFileToMediaBucket } from './uploads';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./api', () => ({ authFetch: request }));
afterEach(() => vi.resetAllMocks());

it('uploads the original file to its intended media kind and returns producer metadata', async () => {
  const file = new File(['fictional audio'], 'song.wav', { type: 'audio/wav' });
  const uploaded = { key: 'songs/one.wav', url: 'https://media.example/one.wav', bucket: 'media', contentType: 'audio/wav', sizeBytes: file.size };
  request.mockResolvedValue(new Response(JSON.stringify(uploaded)));
  await expect(uploadFileToMediaBucket('song', file)).resolves.toEqual(uploaded);
  const [path, options] = request.mock.calls[0];
  expect(path).toBe('/uploads/song');
  expect(options.method).toBe('POST');
  expect(options.body).toBeInstanceOf(FormData);
  expect(options.body.get('file')).toEqual(file);
});

it.each([['File is too large', 'File is too large'], ['', 'Upload failed (413)']])('reports rejected uploads with body %s', async (body, message) => {
  request.mockResolvedValue(new Response(body, { status: 413 }));
  await expect(uploadFileToMediaBucket('background', new File(['image'], 'image.png'))).rejects.toThrow(message);
});

it('propagates failed upload transport rather than returning an invented media URL', async () => {
  request.mockRejectedValue(new Error('offline'));
  await expect(uploadFileToMediaBucket('artwork', new File(['image'], 'image.png'))).rejects.toThrow('offline');
});
