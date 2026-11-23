/** Response media types the remote audio fetch accepts. */
export function isAudioMediaType(mediaType: string): boolean {
  return (
    /^audio\/[a-z0-9.+-]+$/.test(mediaType) || mediaType === 'application/ogg'
  );
}
