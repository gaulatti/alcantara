import { isIP } from 'node:net';

/**
 * The Secrets Manager payload of one destination: the shape the ingest route and Croccante read.
 * One validator serves both directions (gaulatti/alcantara#376 writes what #374 reads), so what is
 * saved is exactly what is accepted when it is read back.
 */
export interface IngestPayload {
  scheme: 'rtmp' | 'rtmps';
  host: string;
  port?: number;
  application: string;
  streamKey: string;
}

/** A refusal whose text is safe to show: it never contains the key. */
export class IngestPayloadError extends Error {}

export const YOUTUBE_INGEST_URL = 'rtmps://a.rtmps.youtube.com:443/live2';

const FIELDS = new Set(['scheme', 'host', 'port', 'application', 'streamKey']);
const HOST_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const APPLICATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Validates a payload read from, or about to be written to, Secrets Manager. */
export function parseIngestPayload(value: unknown): {
  payload: IngestPayload;
  ingestUrl: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IngestPayloadError('The destination payload is invalid');
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !FIELDS.has(key))) {
    throw new IngestPayloadError('The destination payload is invalid');
  }
  const { scheme, host, port, application, streamKey } = fields;
  if (scheme !== 'rtmp' && scheme !== 'rtmps') {
    throw new IngestPayloadError(
      'The ingest URL must start with rtmp:// or rtmps://',
    );
  }
  if (
    typeof host !== 'string' ||
    !(HOST_PATTERN.test(host) || isIP(host) !== 0)
  ) {
    throw new IngestPayloadError('The ingest URL needs a valid host');
  }
  if (
    typeof application !== 'string' ||
    !APPLICATION_PATTERN.test(application) ||
    application.split('/').includes('..')
  ) {
    throw new IngestPayloadError(
      'The ingest URL needs a valid application path',
    );
  }
  if (
    typeof streamKey !== 'string' ||
    streamKey.length < 1 ||
    streamKey.length > 512 ||
    /\s/.test(streamKey) ||
    [...streamKey].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new IngestPayloadError(
      'The stream key must be 1 to 512 characters with no spaces',
    );
  }
  let authority = isIP(host) === 6 ? `[${host}]` : host;
  if (port !== undefined) {
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new IngestPayloadError('The ingest URL port is invalid');
    }
    authority = `${authority}:${port}`;
  }
  return {
    payload: {
      scheme,
      host,
      ...(port === undefined ? {} : { port }),
      application,
      streamKey,
    },
    ingestUrl: `${scheme}://${authority}/${application}`,
  };
}

/** Builds a payload from an ingest URL (`rtmp(s)://host[:port]/application`) and a key. */
export function payloadFromIngestUrl(
  ingestUrl: string,
  streamKey: string,
): { payload: IngestPayload; ingestUrl: string } {
  let url: URL;
  try {
    url = new URL(ingestUrl.trim());
  } catch {
    throw new IngestPayloadError('The ingest URL is not a valid address');
  }
  const scheme = url.protocol.slice(0, -1);
  if (url.username || url.password || url.search || url.hash) {
    throw new IngestPayloadError(
      'The ingest URL must not carry credentials, a query or a fragment',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const application = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  return parseIngestPayload({
    scheme,
    host,
    ...(url.port ? { port: Number(url.port) } : {}),
    application,
    streamKey,
  });
}
