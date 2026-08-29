# External source registry

Alcantara owns stable external-source identity at `/external-sources`. The
authenticated API is team-scoped by the Pompeii
authorization decision and uses the existing WebRTC read/operate permissions.
Sources are assigned to one or more existing programs; scenes using the
`video-stream` layout persist `externalSourceId` and reject embedded
`sourceUrl` values. Layouts never contain publisher credentials or pull URLs.

Supported transports are RTMP, WHIP, HLS, and SRT. Push-source creation returns
one random publisher secret exactly once. Only its salted scrypt hash and
monotonic credential version are stored. Rotation revokes all prior versions,
clears transient ingress/participant identity, and returns a replacement once.
Deleting a source is a revocation: it retains audit identity while clearing
runtime references and revoking credentials.

HLS accepts only credential-free HTTPS URLs; SRT accepts only credential-free
`srt:` URLs. Initial configuration, redirect validation, and every reconciliation
resolve the hostname again and reject loopback, private, link-local, carrier
NAT, multicast, reserved, and metadata-address destinations. The future Ingress
adapter must call `POST /external-sources/:id/redirects/validate` before following
each redirect and must never log the URL.

Transport configuration is AES-256-GCM ciphertext authenticated to team and
stable source ID with a unique nonce. Production supplies these allowlisted
Secrets Manager scalars:

```json
{
  "externalSourceConfigCurrentVersion": "1",
  "externalSourceConfigKeys": "{\"1\":\"base64-encoded-32-byte-root\"}"
}
```

Use a distinct random root per environment. To rotate, add a new version while
retaining old versions, set the current version, deploy, rewrite sources through
the update/reconciliation path, verify inventory, then remove old versions only
after the rollback window. Loss of a referenced root makes that configuration
unrecoverable; restore the secret or reconfigure the source. Startup fails
closed in production if the current key is absent or malformed.

`EXTERNAL_SOURCE_TEAM_QUOTA` defaults to 16 and is bounded to 1-100. Registry
operations expose `alcantara_external_source_operations_total{action,result}`;
inventory exposes `alcantara_external_source_inventory{transport,lifecycle}`.
All labels are fixed enums. Team IDs, source IDs, program IDs, URLs, credentials,
config, and errors never enter metric labels.

Reconciliation accepts only bounded lifecycle and health enums and updates
transient Ingress/participant references. A revoked source cannot reconcile.
Cleanup is explicit and idempotent through revocation or credential rotation;
neither path can auto-take a source to Preview or Program.
