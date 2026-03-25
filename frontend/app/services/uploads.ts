import { apiUrl } from '../utils/apiBaseUrl';

export type UploadKind = 'instant' | 'artwork' | 'song';

interface UploadResponse {
  key: string;
  url: string;
  bucket: string;
  contentType: string;
  sizeBytes: number;
  metadata?: {
    artist?: string;
    title?: string;
    durationMs?: number;
    coverUrl?: string;
  };
}

export async function uploadFileToMediaBucket(
  kind: UploadKind,
  file: File,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(apiUrl(`/uploads/${kind}`), {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Upload failed (${res.status})`);
  }

  return (await res.json()) as UploadResponse;
}
