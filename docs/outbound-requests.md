# Outbound requests for supplied URLs

When the backend fetches a URL that it did not choose itself (one an operator
entered, a database row holds or another service sent), it goes through one
outbound-request policy: `backend/src/outbound/safe-fetch.ts`, built on Node's
`https.request` with no extra dependency.

## Policy

- **Scheme:** `https` only, on any port. The URL may not carry a user name or
  password.
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

The program page calls it only for audio whose origin differs from the page
(the loudness envelope of a track). It returns the body with only its
`Content-Type` and `Content-Length`; `Range` is not forwarded (the page does
not send one). Audio in the managed media bucket (`MEDIA_S3_BUCKET`, in
`AWS_REGION`: `<bucket>.s3.<region>.amazonaws.com` or
`<bucket>.s3.amazonaws.com`) is public https, so it passes.

## What the caller sees on a refusal

The program page's remote audio read answers with a JSON error and a plain message; the URL
is never echoed:

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
policy. `path` is the caller (`program_audio`, `now_playing`); `result` is `ok`,
`legacy_http` or one of the refusal reasons above. Every series starts at
zero. No URL, host or address appears in a label or a log line.
