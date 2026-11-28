# Guest calls: what runs, where, and how to look after it

The map of the calls stack. Details live in the pages linked from each section. Checked against the code and against
production on 2026-11-28.

## Not built

- **Chat**, general or producer one-to-one. The studio can send a guest a private message; a guest cannot write back.
- **Guest screen share.** A guest sends a camera and a microphone only.
- **Recording of calls.** Nothing records the call room, a guest or a source: no LiveKit Egress runs, and no part of
  Alcántara writes call media. The console's Program recording controls drive Alana's recorder
  ([program-recording.md](program-recording.md)), which belongs to the television chain and records no call source by
  itself. Television (Alana, Croccante) is not on air.
- **External sources through LiveKit Ingress** (RTMP, WHIP, HLS, SRT). The registry exists
  ([external-source-registry.md](external-source-registry.md)); the Ingress service is defined but not run
  ([infra/README.md](../infra/README.md)).

## Architecture

| Component | Production | Local (`docker compose up`) |
| --- | --- | --- |
| LiveKit server 1.13.4 (with Redis in production) | Helix, started by `infra/helix/livekit-up.sh` | `livekit` |
| Backend (`/webrtc/*` routes, tokens, guest state) | cumulus | `backend` |
| Console (`/calls`), guest page (`/guest/:invitation`), return router (`/return-router/:programId`) | the frontend | `frontend` |
| Return runner: keeps a headless return router open for each program with guests | Helix, `alcantara-return-runner` | `return-runner` |
| Contribution worker: puts guests cued live and the host mic on the station's air | cumulus, `alcantara-contribution`, one program | `contribution` |
| Palazzo's live input, which the worker feeds | cumulus | `air-sink`, an RTMP receiver that only receives |

How a guest is admitted, hears the studio and reaches air:
[README: Six-guest WebRTC contribution](../README.md#six-guest-webrtc-contribution). The operator's steps:
[operator-calls-quickstart.md](operator-calls-quickstart.md).

The desktop pilot can publish a program feed (`desktop-program-feed-<programId>`) for guests to see. That has been
checked on a local stack; it has not yet been confirmed against production (gaulatti/alcantara#354). With no program
feed in the room, a guest's return carries the program's own audio from the radio engine, the other guests and the
studio's talkback.

## Local development

`docker compose up --build` starts everything in the table above with fixed local-only credentials; see
[README: Local and production operations](../README.md#local-and-production-operations) and
[e2e/README.md](../e2e/README.md) for the scripted calls. The two workers use host networking: Linux and Colima need
nothing, Docker Desktop needs host networking turned on. The contribution worker serves one program,
`radio-demo.fm` unless `CONTRIBUTION_PROGRAM_ID` says otherwise. No local radio engine serves program audio, so the
local return has no program bed.

## Configuration

Production reads the LiveKit group from the runtime secret `broadcast/production/config`: `livekitWsUrl`,
`livekitApiKey`, `livekitApiSecret` and `webrtcSessionSecret`, all present or all absent. Optional: the renderer keys
(`webrtcRendererKey`, `webrtcFleetKey`, `webrtcProgramKeys`, see [renderer-keys.md](renderer-keys.md)) and
`livekitTurnTlsDomain`. With the group absent or invalid the backend still starts, with calls off. Compose sets the
matching variables itself.

## Networking

- `livekit.alcantara.gaulatti.com`, 443: signalling and the LiveKit API, through nginx on Helix.
- `7882/udp`: media. `7881/tcp`: media over TCP. `3478/udp`: TURN.
- `turn.alcantara.gaulatti.com`, 443: TURN over TLS, for networks that allow only 443. It is live.

[infra/README.md](../infra/README.md) has the port table and the one-time host setup.

## Observability

- On `/calls`: the connection state, an amber line when part of the chain is down, and per guest the path of their
  call or why their last join failed.
- `GET /webrtc/health?programId=…` (operator), and the MCP tool `webrtc_health`: the return runner, the contribution
  worker and LiveKit.
- Metrics: `alcantara_webrtc_*` on the backend's private `/metrics`; `alcantara_contribution_*` on the worker
  (`:8091`, internal); `return_runner_*` on the runner (`:8090`, inside its container). Their meaning is in the
  [README](../README.md#call-telemetry) and [infra/README.md](../infra/README.md).
- Logs: `docker logs alcantara-return-runner` (Helix), `docker logs alcantara-contribution` (cumulus),
  `docker logs alcantara-livekit` (Helix).
- [production-status.md](production-status.md): one read-only command for the calls claims.

## Deployment

The backend and the frontend deploy from `main` through their workflows. The other three do not: LiveKit, the return
runner and the contribution worker are started or updated by hand with `infra/helix/livekit-up.sh`,
`infra/helix/return-runner-up.sh` and `infra/cumulus/contribution-up.sh` ([infra/README.md](../infra/README.md)).
Restarting LiveKit drops calls in progress.

## Rollback

There is none for calls: fix forward and redeploy the part that is wrong. Stopping the contribution worker removes
only the live input (music and filler carry on); stopping the return runner takes the guests' returns away. The one
exception is the nginx change for TURN over TLS, whose script restores the previous configuration by itself if it
fails ([infra/README.md](../infra/README.md#turn-over-tls-on-443)).

## Troubleshooting

| What you see | Look at |
| --- | --- |
| `/calls` says **Guest calls need LiveKit** | The LiveKit group is missing or invalid in the secret; the backend log names the fields. |
| Amber line: guests can't reach air | The contribution worker: its container and log on cumulus. Palazzo must be listening on its live input. |
| A guest hears nothing | The return runner on Helix: its log shows each router page's own lines. |
| A guest cannot join from their network | Their row on `/calls` says why. A network allowing only 443 needs TURN over TLS to be answering; otherwise ask them to change network. |
| Local: the first guest page load times out on a fresh stack | The dev server is still optimising dependencies; load again. |
| Local: a real Chrome asks to access the local network | Allow it; LiveKit is on localhost. |
| Local: the return router logs `ticket_502` | Expected: no local radio engine serves program audio. |
