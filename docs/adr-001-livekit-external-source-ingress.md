# ADR 001: LiveKit Ingress for managed external sources

- Status: proposed from executable spike
- Date: 2026-08-25
- Issue: [#21](https://github.com/gaulatti/alcantara/issues/21)

## Decision

Alcantara will own a persistent `ExternalSource` control-plane entity and use
self-hosted LiveKit Ingress as the common media boundary for RTMP/RTMPS, WHIP,
HLS, and SRT. Scenes and layouts reference the stable Alcantara source ID, not
a URL, stream key, ingress ID, or transient participant identity. Browser-call
guests keep their invitation and mix-minus model but implement the same runtime
source interface.

Direct browser playback remains a compatibility-only escape hatch. Custom
FFmpeg/GStreamer bridges are reserved for codecs or transports that Ingress
cannot normalize. They are not a second control plane.

Alcantara provisions and authorizes sources, LiveKit Ingress receives and
normalizes contribution media, Alana owns Preview/Program rendering and output,
and Croccante owns final platform fan-out. No ingress connection reaches air
without an explicit operator Preview/CUT/TAKE action.

## Alternatives

| Option | Result |
| --- | --- |
| Browser URL in each scene | Rejected as the primary path: no stable identity, centralized health, credential lifecycle, normalization, or reusable decode. |
| LiveKit Ingress only | Selected for supported protocols; one discoverable participant contract and mature Redis/API lifecycle. |
| Per-protocol custom bridges | Rejected as the default due to duplicated lifecycle, observability, security, and transcoding work. |
| Hybrid | Selected narrowly: Ingress by default, a managed bridge only for an unsupported codec/transport, and browser playback as monitored compatibility mode. |

## Domain model

`ExternalSource` persists `id`, `teamId`, optional `programId`, display name,
transport, encrypted transport configuration, credential version, desired
normalization profile, lifecycle, health, last-connected time, and current
Ingress/participant references. A source may be assigned to multiple programs
through an explicit join table, but a runtime ingress belongs to one program
room. Server-side team/program authorization is mandatory.

Lifecycle is `unconfigured -> provisioning -> waiting -> connected`, with
side states `degraded`, `reconnecting`, `offline`, and terminal `revoked`.
Transient LiveKit identities are derived from the stable source ID and never
become layout identity. Reusable RTMP/WHIP endpoints return to `waiting` after a
publisher leaves; URL inputs are one-shot and are recreated during recovery.

```mermaid
sequenceDiagram
  participant O as Operator
  participant A as Alcantara
  participant I as LiveKit Ingress
  participant L as LiveKit room
  participant R as Alana renderer
  O->>A: Register source and program assignment
  A->>I: Create ingress with stable source metadata
  I-->>A: Publisher endpoint or URL-input state
  A-->>O: One-time credential (push only)
  I->>L: Publish named A/V participant
  L-->>A: Health and track events
  A-->>O: Source browser: connected
  O->>A: Select Preview
  A->>R: Subscribe source into Preview
  O->>A: CUT/TAKE
  A->>R: Promote explicit source to Program
  I--xL: Source loss
  A-->>O: Reconnecting; retain policy-driven slate/silence
  I->>L: Republish same stable source identity
  O->>A: Revoke
  A->>I: Delete ingress and disconnect participant
  A-->>O: Source revoked
```

## Media and operator policy

The baseline normalization target is H.264, 1280x720, 30 fps, Opus 48 kHz,
with an optional 1080p profile after capacity testing. Compatible WHIP may
bypass transcoding; all other paths normalize. Preview subscribes only the
selected source. Alana subscribes sources referenced by the active Preview and
Program compositions and reuses each room track across layouts.

Alcantara owns source meters, gain, mute, solo, input delay, channel mapping,
tally, and cue state; Alana applies the authoritative render/audio graph. On a
Program failure, Alana holds the last frame for at most two seconds, then shows
a named slate and silence while Alcantara reports reconnecting. Preview shows
the failure immediately. A failed source cannot mutate any other source or the
room/output lifecycle.

## Protocol evidence

The reproducible local harness uses LiveKit Server 1.13.4 and Ingress 1.5.0 on
a 10-core Apple development host. Timings are source-start to discoverable A/V,
not glass-to-glass; the production benchmark ticket must measure a rendered
timecode at Alana's Program output.

| Path | Local result | Ready time | Ingress CPU / memory | Classification |
| --- | --- | ---: | ---: | --- |
| RTMP | Named 720p30 H.264 + Opus participant | 1.59 s warm | 63.38% / 89.64 MiB | Production contribution; RTMPS at the edge |
| WHIP | Named 720p30 H.264 + Opus participant; compatible bypass | about 1.6 s after warm image start | 4.81% / 18.77 MiB | Preferred low-latency contribution |
| HLS | Named 720p30 H.264 + Opus participant | 2.61 s initial run | 62.76% / 138.7 MiB | Compatibility pull; segment latency applies |
| SRT | Input H.264/AAC was detected and a participant/audio track published, but Ingress 1.5.0 on arm64 emitted no usable video packets and ended `source encoder not ready` | failed at 60 s | inconclusive | Blocked from production until x86/i9 certification |

RTMP and HLS remained simultaneously discoverable with both A/V tracks. Their
combined Ingress snapshot was 111.02% CPU and 220.7 MiB. Deleting HLS left RTMP
connected, proving failure/lifecycle isolation at the room boundary. Deleting
the RTMP ingress removed its participant and invalidated the endpoint.

The SRT result is a material negative finding, not a pass. Both GStreamer and
FFmpeg MPEG-TS/SRT senders reproduced it while Ingress reported valid input
resolution, frame rate, and bitrate. Production SRT must remain disabled until
the Intel target passes the follow-up certification.

## Capacity

For the 10-core development allocation, admit at most four 720p30 transcoding
sources or eight verified WHIP-bypass sources, while reserving 30% CPU and
enforcing per-team quotas. Two representative transcodes consumed about 1.11
cores and 221 MiB in this short proof, but burst/reconnect and long-run behavior
were not measured. The Intel i9 limit must be derived from a 60-minute mixed
protocol soak; architecture and hardware encoding differences make a direct
Apple-to-Intel multiplier unsafe.

## Security and operations

- The backend creates ingresses; API secrets never reach publishers or browsers.
- Push credentials are one-time displayed, versioned, revocable, and stored as
  hashes. Rotate by creating a replacement before deleting the old endpoint.
- Ingress 1.5.0 logged the complete RTMP publishing name, which is the stream
  key. Both `log_level: warn` and the current `logging.level: warn` still left
  the underlying RTMP library's info messages enabled. RTMP promotion is blocked
  until the service is patched/upgraded to suppress or redact those messages;
  collector redaction is defense in depth, not the primary control. A canary
  secret scan is a deployment gate.
- HLS/SRT accept only `https`, `srt`, and explicitly approved internal schemes.
  Resolve DNS before every connection and redirect, deny loopback/link-local/
  metadata/private ranges by default, pin the approved result, bound redirects,
  strip URL credentials from logs, and store required headers encrypted.
- Expose RTMPS and WHIP over TLS; expose the configured WHIP UDP range. Keep
  Redis and health/Prometheus ports private. Rate-limit provisioning and enforce
  concurrent-source and bitrate quotas.
- Reconcile desired sources against Ingress and room state, expire abandoned URL
  sessions, alert on reconnect loops/capacity/zero packets, and never auto-take.

## Consequences and rollout

The persistent registry and infrastructure precede operator UI and Alana
rendering. Protocol certification gates enablement independently. WHIP and HLS
can advance; RTMP is gated on log redaction and SRT on a successful x86/i9 media
proof. Existing guest behavior is preserved and adapted rather than rewritten.
Croccante remains downstream and does not learn source protocols.

Primary references: [LiveKit Ingress overview](https://docs.livekit.io/transport/media/ingress-egress/ingress/),
[encoder inputs](https://docs.livekit.io/transport/media/ingress-egress/ingress/encoders/),
and the [self-hosted Ingress repository](https://github.com/livekit/ingress).
