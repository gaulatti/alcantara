import { createRequire } from 'node:module';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// gaulatti/alcantara#354: writes the LiveKit server configuration (livekit.yaml)
// from the runtime secret to stdout, for the deploy to place in a 0600 file.
// Exit 0: written. Exit 3: the secret has no LiveKit group (WebRTC stays off).
// Exit 1: unavailable or invalid. Never logs a key, a secret or the payload.
const require = createRequire(import.meta.url);
const {
  parseRuntimeSecretPayload,
} = require('../src/config/runtime-secret-contract.js');
const {
  renderLivekitServerConfig,
  turnTlsDomainFrom,
} = require('../src/config/livekit-server-config.js');

const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
const region = process.env.AWS_REGION?.trim();
if (!secretId || !region) {
  console.error('ALCANTARA_CONFIG_SECRET_ID and AWS_REGION are required');
  process.exit(1);
}

let selected;
// Read apart from the backend's contract: only this renderer uses it, and the backend ignores it.
let turnTlsDomain;
try {
  const response = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  selected = parseRuntimeSecretPayload(response.SecretString);
  if (selected.livekitWsUrl !== undefined)
    turnTlsDomain = turnTlsDomainFrom(
      JSON.parse(response.SecretString).livekitTurnTlsDomain,
      selected.livekitWsUrl,
    );
} catch (error) {
  // The contract's messages name fields, never values.
  console.error(
    error instanceof Error
      ? error.message
      : 'Alcantara runtime configuration is unavailable',
  );
  process.exit(1);
}
if (selected.livekitWsUrl === undefined) {
  console.error('LiveKit is not configured in the runtime secret');
  process.exit(3);
}
process.stdout.write(renderLivekitServerConfig(selected, { turnTlsDomain }));
