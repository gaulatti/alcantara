# Outbound requests for supplied URLs

When the backend fetches a URL that it did not choose itself (one an operator
entered, a database row holds or another service sent), it goes through one
outbound-request policy: `backend/src/outbound/safe-fetch.ts`, built on Node's
`https.request` with no extra dependency.

## Policy

- **Scheme:** `https` only, on any port. The URL may not carry a user name or
  password. The one exception is a now-playing consumer stored with a plain
  `http` URL before https was required: it still delivers, under every other
  rule here, and is counted as `legacy_http`. A media analysis input keeps
  the job's existing `http` or `https` rule (see below). A redirect is never
  followed to plain `http`.
- **Addresses:** the host name is resolved and every address it resolves to
  must be public (`backend/src/outbound/address-policy.ts`). Unspecified,
  loopback, private (RFC 1918 and IPv6 ULA), carrier-grade NAT, link-local
  (including `169.254.169.254`), multicast, reserved, documentation and
  benchmarking ranges are refused, as is an IPv4 address embedded in an
  IPv4-mapped or NAT64 IPv6 address. An IP literal is checked the same way.
- **Connection:** the socket connects to the address that was checked; the
  name is not resolved a second time. TLS keeps the host name for SNI and
  certificate checks, and the `Host` header is the URL's host.
- **Redirects:** followed by the policy, never by the transport. Each hop is
  parsed again (`https` only), resolved and checked again, up to the caller's
  hop limit.
- **Limits:** one deadline for the whole exchange, a byte limit enforced while
  the body streams, and a content-type allow-list chosen by the caller.
- **Headers:** only the request headers the caller chooses are sent (no
  cookies or credentials from an incoming request), and only the response
  fields the caller reads are used.

## Callers

| Caller | Method | Accepts | Limits |
| --- | --- | --- | --- |
| Program page remote audio (`ProgramService`) | GET, no request headers | `audio/*`, `application/ogg` | 100 MiB, 60 s, 3 redirects |
| Media analysis input (`FfmpegAudioAnalyzer`) | GET with `User-Agent: alcantara-media-analysis` only; `http` is counted as `legacy_http` | `audio/*`, `application/ogg` | 200 MiB (the upload limit), streamed to a temporary file; 180 s per file shared with the tools; no redirects |
| Media import by URL (`UploadsService.importFromUrl`, MCP `import_media_from_url`) | GET, no request headers; `https` only | `audio/*`, `application/ogg` | 200 MiB (the upload limit), streamed under the cap into the upload; 120 s; 3 redirects |
| Now-playing delivery (`NowPlayingPublisherService`) | The consumer's POST, PUT or PATCH, with `Content-Type: application/json` and the consumer's own headers | Any 2xx; the answer is not read | 10 s, 3 redirects |

The program page calls it only for audio whose origin differs from the page
(the loudness envelope of a track). It returns the body with only its
`Content-Type` and `Content-Length`; `Range` is not forwarded (the page does
not send one). Audio in the managed media bucket (`MEDIA_S3_BUCKET`, in
`AWS_REGION`: `<bucket>.s3.<region>.amazonaws.com` or
`<bucket>.s3.amazonaws.com`) is public https, so it passes.

## Now-playing consumers

Consumers are saved from Radio settings (`PUT /radio/:programId/now-playing-consumers`).
A save is refused with a 400 and a plain message naming the consumer by its
position, never the URL; Radio settings shows that message:

| Case | Message |
| --- | --- |
| Not an absolute URL | `Consumer N: the URL is not a valid absolute URL.` |
| Carries a user name or password | `Consumer N: the URL must not include a user name or password.` |
| Any scheme but `https` | `Consumer N: the URL must use https.` |

A consumer already stored with a plain `http` URL may be submitted again
unchanged (so the rest of the list can still be edited); changing that URL
requires https. Such a consumer keeps delivering to public addresses only, is
counted as `legacy_http`, and each delivery logs a warning that names the
consumer (`<program>/<name>`) and asks for its URL to be changed to https.

Every delivery goes through the policy above; outside production none is made
at all (see the README's local stack notes). The delivery log lines carry the
program, the consumer name, the method, the answer status or the refusal
reason; never the URL, the request headers, the payload or the answer body. A
refused or failed delivery is logged and counted; it never stops playout or
the delivery to other consumers. `alcantara_dependency_operations_total{dependency="now-playing"}`
keeps its `success`, `http-error` (a non-2xx answer) and `unavailable` (any
other refusal) results.

## Media analysis inputs

The media analysis job fetches a remote `MediaAsset.sourceUrl` through this
policy and streams the body into a temporary file (mode 0600, in its own
directory under the OS temporary directory). `ffprobe` and `ffmpeg` then read
only that file, with `-protocol_whitelist file`; neither tool is ever given a
network address, so the address that was checked is the address that was
read. The fetch follows no redirect, accepts only an audio content type, stops
at 200 MiB, and shares the file's 180 second deadline with the tools. The
temporary directory is removed after every run: success, refusal, tool
failure and timeout.

A refusal fails the analysis row without running a tool: `source-refused`
(final) for an invalid URL, a non-public address, a redirect, another content
type or an oversized body; `source-unresolved` (retried) when the host does
not resolve; `source-unavailable` (retried) for an error status or a failed
connection; `timeout` when the deadline passes. The worker carries on with the
next asset.

## What the caller sees on a refusal

The program page's remote audio read answers with a JSON error and a plain message; the URL
is never echoed (a now-playing delivery logs the reason instead):

| Reason | Status | Message |
| --- | --- | --- |
| `invalid_url` | 400 | The address is not a valid absolute URL. |
| `scheme` | 400 | The address must use https. |
| `address` | 400 | The address points at a private, local or reserved network, which the server never fetches. |
| `dns` | 400 | The address host name could not be resolved. |
| `redirects` | 400 | The address redirects too many times. |
| `too_large` | 400 | The response is larger than the server accepts. |
| `content_type` | 400 | The response is not a type the server accepts here. |
| `http_status` | 502 | The address answered with an error status. |
| `network` | 502 | The address could not be reached. |
| `timeout` | 504 | The address did not answer in time. |

On the program page a refusal only means no loudness envelope for that track;
the track itself still plays.

## Metric

`alcantara_outbound_fetch_total{path,result}` counts every fetch under the
policy. `path` is the caller (`program_audio`, `now_playing`,
`media_analysis`, `media_import`); `result` is `ok`, `legacy_http` or one of the refusal
reasons above. For `media_analysis` it counts the input fetch, which
is the only read: the tools open the fetched file. For `media_import` it counts
the fetch of the MCP capability `import_media_from_url` (an audio file streamed
under the 200 MiB cap, then stored as an upload). Every series starts at
zero. No URL, host or address appears in a label or a log line.
