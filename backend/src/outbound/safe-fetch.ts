import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Writable } from 'node:stream';
import { unsafeAddress } from './address-policy';

/**
 * alcantara#207: the one outbound-request policy for a URL someone else
 * supplied (an operator, a database row or another service).
 *
 * - https only (a caller may allow a recorded legacy http consumer, which is
 *   still held to the address rule and counted as legacy_http);
 * - public addresses only: every address the name resolves to is checked,
 *   and the socket connects to the checked address (the lookup hands Node
 *   only that address, so nothing resolves the name again), keeping SNI and
 *   the Host header; an IP literal is checked before any connection;
 * - redirects are followed by hand, each hop parsed, resolved and checked
 *   again, up to a hop limit;
 * - one deadline for the whole exchange, a byte cap enforced while
 *   streaming, and a content-type allow-list chosen by the caller;
 * - no request header the caller did not choose, no cookies, and only the
 *   response headers the caller reads.
 */

/** Every caller of the policy (a bounded metric label). */
export const OUTBOUND_FETCH_PATHS = [
  'program_audio',
  'now_playing',
  'media_analysis',
  'media_import',
] as const;
export type OutboundFetchPath = (typeof OUTBOUND_FETCH_PATHS)[number];

/** The outcome of one fetch (a bounded metric label). */
export const OUTBOUND_FETCH_RESULTS = [
  'ok',
  'legacy_http',
  'invalid_url',
  'scheme',
  'address',
  'dns',
  'redirects',
  'too_large',
  'timeout',
  'content_type',
  'http_status',
  'network',
] as const;
export type OutboundFetchResult = (typeof OUTBOUND_FETCH_RESULTS)[number];
export type OutboundRefusalReason = Exclude<
  OutboundFetchResult,
  'ok' | 'legacy_http'
>;

/** What the operator or listener is told, per refusal (never the URL). */
export const OUTBOUND_REFUSAL_MESSAGES: Record<OutboundRefusalReason, string> =
  {
    invalid_url: 'The address is not a valid absolute URL.',
    scheme: 'The address must use https.',
    address:
      'The address points at a private, local or reserved network, which the server never fetches.',
    dns: 'The address host name could not be resolved.',
    redirects: 'The address redirects too many times.',
    too_large: 'The response is larger than the server accepts.',
    timeout: 'The address did not answer in time.',
    content_type: 'The response is not a type the server accepts here.',
    http_status: 'The address answered with an error status.',
    network: 'The address could not be reached.',
  };

export class OutboundRefusal extends Error {
  constructor(
    readonly reason: OutboundRefusalReason,
    readonly upstreamStatus?: number,
  ) {
    super(OUTBOUND_REFUSAL_MESSAGES[reason]);
    this.name = 'OutboundRefusal';
  }
}

export interface SafeFetchOptions {
  path: OutboundFetchPath;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Request headers the caller chooses; nothing else is sent. */
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Lower-cased media type (no parameters) allowed for the response. */
  allowContentType: (mediaType: string) => boolean;
  /** Read the response body (false for a webhook that ignores it). */
  readBody?: boolean;
  /** A recorded consumer that predates https-only (still address-checked). */
  allowLegacyHttp?: boolean;
  /**
   * Stream the body into this writable instead of returning it, under the
   * same byte cap and deadline. The body in the response is then empty and
   * contentLength counts the bytes written. The caller owns the writable and
   * closes it after a refusal.
   */
  bodySink?: Writable;
}

export interface SafeFetchResponse {
  status: number;
  /** The media type, checked against the allow-list ('' when not read). */
  contentType: string;
  contentLength: number | null;
  body: Buffer;
  legacyHttp: boolean;
}

export type ResolveAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface SafeFetchDeps {
  resolve?: ResolveAll;
  /** The request function (https.request, or http.request for legacy). */
  request?: (
    scheme: 'https:' | 'http:',
    options: https.RequestOptions,
  ) => http.ClientRequest;
  record?: (path: OutboundFetchPath, result: OutboundFetchResult) => void;
}

export const defaultResolve: ResolveAll = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

export const defaultRequest = (
  scheme: 'https:' | 'http:',
  options: https.RequestOptions,
) => (scheme === 'https:' ? https.request(options) : http.request(options));

/**
 * Resolves `hostname`, refuses it unless every address is public, and
 * returns the address the connection must use.
 */
export async function checkedAddress(
  hostname: string,
  resolve: ResolveAll = defaultResolve,
): Promise<{ address: string; family: 4 | 6 }> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(bare);
  if (literal) {
    if (unsafeAddress(bare)) throw new OutboundRefusal('address');
    return { address: bare, family: literal as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(bare);
  } catch {
    throw new OutboundRefusal('dns');
  }
  if (!addresses.length) throw new OutboundRefusal('dns');
  if (addresses.some(({ address }) => unsafeAddress(address)))
    throw new OutboundRefusal('address');
  const first = addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** A lookup that only ever answers the already checked address. */
export function pinnedLookup(pinned: {
  address: string;
  family: 4 | 6;
}): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const done = (typeof options === 'function' ? options : callback) as (
      error: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const all =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (all) done(null, [{ address: pinned.address, family: pinned.family }]);
    else done(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

function parseUrl(raw: string, allowLegacyHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefusal('invalid_url');
  }
  if (url.username || url.password) throw new OutboundRefusal('invalid_url');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allowLegacyHttp) return url;
  throw new OutboundRefusal('scheme');
}

function mediaType(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  return value.split(';')[0].trim().toLowerCase() || null;
}

/** Fetches `raw` under the policy; throws OutboundRefusal on any refusal. */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResponse> {
  const resolve = deps.resolve ?? defaultResolve;
  const request = deps.request ?? defaultRequest;
  const deadline = Date.now() + options.timeoutMs;
  // Aborting destroys whatever request or response is still open.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs);
  let legacyHttp = false;
  const run = async (): Promise<SafeFetchResponse> => {
    let url = parseUrl(raw, options.allowLegacyHttp === true);
    const hop = async (target: URL) => {
      if (target.protocol === 'http:') legacyHttp = true;
      const pinned = await withDeadline(
        checkedAddress(target.hostname, resolve),
        deadline,
      );
      return withDeadline(
        send(target, pinned, options, request, deadline, abort.signal),
        deadline,
      );
    };
    let response = await hop(url);
    let redirects = 0;
    while (isRedirect(response)) {
      response.resume();
      if (redirects >= options.maxRedirects)
        throw new OutboundRefusal('redirects');
      redirects += 1;
      // A redirect is never to plain http, even from a legacy consumer.
      url = parseUrl(redirectTarget(response, url), false);
      response = await hop(url);
    }
    const status = Number(response.statusCode);
    if (status < 200 || status >= 300) {
      response.resume();
      throw new OutboundRefusal('http_status', status);
    }
    const contentType = mediaType(response.headers['content-type']);
    if (
      options.readBody !== false &&
      (!contentType || !options.allowContentType(contentType))
    ) {
      response.resume();
      throw new OutboundRefusal('content_type');
    }
    // An answer the caller does not read is never measured against the cap.
    const declared = Number(response.headers['content-length']);
    if (
      options.readBody !== false &&
      Number.isFinite(declared) &&
      declared > options.maxBytes
    ) {
      response.resume();
      throw new OutboundRefusal('too_large');
    }
    let body: Buffer = Buffer.alloc(0);
    let contentLength: number | null = null;
    if (options.readBody === false) {
      response.resume();
    } else if (options.bodySink) {
      contentLength = await withDeadline(
        streamCapped(response, options.maxBytes, options.bodySink),
        deadline,
      );
    } else {
      body = await withDeadline(
        readCapped(response, options.maxBytes),
        deadline,
      );
      contentLength = body.byteLength;
    }
    deps.record?.(options.path, legacyHttp ? 'legacy_http' : 'ok');
    return {
      status,
      contentType: contentType ?? '',
      contentLength,
      body,
      legacyHttp,
    };
  };
  return run().then(
    (response) => {
      clearTimeout(timer);
      return response;
    },
    (error: unknown) => {
      clearTimeout(timer);
      abort.abort();
      const refusal =
        error instanceof OutboundRefusal
          ? error
          : new OutboundRefusal('network');
      deps.record?.(options.path, refusal.reason);
      return Promise.reject(refusal);
    },
  );
}

function isRedirect(response: IncomingMessage): boolean {
  const status = Number(response.statusCode);
  return status >= 300 && status < 400 && Boolean(response.headers.location);
}

function redirectTarget(response: IncomingMessage, base: URL): string {
  try {
    return new URL(String(response.headers.location), base).toString();
  } catch {
    throw new OutboundRefusal('invalid_url');
  }
}

function send(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  options: SafeFetchOptions,
  request: NonNullable<SafeFetchDeps['request']>,
  deadline: number,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      ...(options.headers ?? {}),
      host: url.host,
    };
    if (options.body !== undefined)
      headers['content-length'] = Buffer.byteLength(options.body);
    const req = request(url.protocol as 'https:' | 'http:', {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers,
      // Connect to the checked address only; SNI stays the host name.
      lookup: pinnedLookup(pinned),
      servername: isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? undefined
        : url.hostname,
      agent: false,
      timeout: Math.max(1, deadline - Date.now()),
      signal,
    });
    req.once('response', resolve);
    req.once('timeout', () => {
      req.destroy();
      reject(new OutboundRefusal('timeout'));
    });
    // An aborted request is the deadline; withDeadline reports it first.
    req.once('error', () => reject(new OutboundRefusal('network')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function readCapped(response: IncomingMessage, maxBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        response.destroy();
        reject(new OutboundRefusal('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    response.once('end', () => resolve(Buffer.concat(chunks)));
    response.once('error', () => reject(new OutboundRefusal('network')));
  });
}

/**
 * Writes the body into `sink` with backpressure, refusing it once it passes
 * `maxBytes`; resolves with the byte count after the sink has flushed.
 */
function streamCapped(
  response: IncomingMessage,
  maxBytes: number,
  sink: Writable,
) {
  return new Promise<number>((resolve, reject) => {
    let bytes = 0;
    // A settled promise ignores a second outcome.
    const fail = (reason: OutboundRefusalReason) => {
      response.destroy();
      reject(new OutboundRefusal(reason));
    };
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return fail('too_large');
      if (!sink.write(chunk)) {
        response.pause();
        sink.once('drain', () => response.resume());
      }
    });
    response.once('end', () =>
      sink.end((error?: Error | null) =>
        error ? fail('network') : resolve(bytes),
      ),
    );
    response.once('error', () => fail('network'));
    sink.once('error', () => fail('network'));
  });
}

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new OutboundRefusal('timeout'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OutboundRefusal('timeout')),
      remaining,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
