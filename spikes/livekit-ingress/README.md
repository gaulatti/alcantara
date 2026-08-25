# LiveKit external-source proof

This disposable harness supports ADR 001. It is not a production deployment.
All committed credentials are local-only and the Compose project name prevents
collisions with Alcantara's normal stack.

```bash
docker compose -f spikes/livekit-ingress/compose.yml up -d
node spikes/livekit-ingress/probe.mjs create rtmp source-rtmp
node spikes/livekit-ingress/probe.mjs create whip source-whip
node spikes/livekit-ingress/probe.mjs create hls source-hls http://media/stream.m3u8
node spikes/livekit-ingress/probe.mjs create srt source-srt \
  'srt://srt-source:19000?mode=caller&latency=200000'
node spikes/livekit-ingress/probe.mjs summary
node spikes/livekit-ingress/probe.mjs wait source-rtmp 30000
node spikes/livekit-ingress/probe.mjs delete-all
docker compose -f spikes/livekit-ingress/compose.yml down
```

`create` intentionally returns a push credential to the invoking operator;
never paste that JSON into logs or issue comments. `summary` redacts it. URL
inputs start immediately and cannot be reused; RTMP/WHIP endpoints wait for a
publisher and can accept a later reconnect.

Warning: Ingress 1.5.0's RTMP library logs the complete publishing name even
with structured logging set to `warn`. The publishing name is the stream key.
Use only fictional local keys here; ADR 001 blocks production RTMP until that
path is patched or upgraded and a canary scan passes.

The protocol numbers in `probe.mjs` match LiveKit's API enum: RTMP is `0`, WHIP
is `1`, and URL input (HLS/SRT) is `2`. Source metadata provides stable identity
for discovery without a scene hardcoding a URL or participant ID.

To run HLS, generate a short live playlist into `media/`; generated segments
are ignored by Git. The SRT sender starts with Compose. On Apple arm64 the SRT
proof currently reproduces the ADR's `source encoder not ready` failure and is
kept as a regression harness.

Prometheus is available at `http://localhost:18082/metrics`, health at
`http://localhost:18081`, LiveKit at `ws://localhost:17880`, RTMP at port 19350,
and WHIP at port 18080. The harness binds these ports only for local testing.
