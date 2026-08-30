# Program realtime delivery

Every `GET /program/{programId}/events` SSE connection is an independent
subscriber. The backend subscribes it to live program events before reading
state, sends a complete `program_state_snapshot`, and then flushes any events
that arrived while the snapshot was loading. This ordering prevents a newly
loaded renderer from missing a transition between its initial read and live
subscription.

The SSE response sets `X-Accel-Buffering: no` so nginx forwards events without
buffering. Program renderers also reconcile the public state, audio-bus,
broadcast-settings, scene-instant, and stinger snapshots immediately and every
five seconds, including while the document is hidden. Polling is reconciliation
for an open renderer, not exclusive ownership or a replacement for SSE.

The private Prometheus endpoint exposes:

- `alcantara_program_sse_connections`: currently open program SSE subscribers.
- `alcantara_program_sse_snapshots_total{result}`: initial snapshot outcomes;
  `result` is bounded to `success`, `failure`, or `unknown`.
