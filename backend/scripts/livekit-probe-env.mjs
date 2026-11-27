import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// gaulatti/alcantara#354: writes LiveKit's public URL, API key and API secret from the runtime secret into an env file
// (mode 0600) for infra/livekit-load-probe.sh, which hands it to the LiveKit CLI. It loads the secret as
// print-livekit-config.mjs does. Exit 0: written. Exit 3: the secret has no LiveKit group. Exit 1: unavailable or
// invalid. Never prints a key, a secret or the payload; only the file holds them.
const require = createRequire(import.meta.url);
const {
  parseRuntimeSecretPayload,
} = require('../src/config/runtime-secret-contract.js');

const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
const region = process.env.AWS_REGION?.trim();
const target = process.argv[2]?.trim();
if (!secretId || !region || !target) {
  console.error(
    'ALCANTARA_CONFIG_SECRET_ID, AWS_REGION and an output file argument are required',
  );
  process.exit(1);
}

let selected;
try {
  const response = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  selected = parseRuntimeSecretPayload(response.SecretString);
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
writeFileSync(
  target,
  [
    `LIVEKIT_URL=${selected.livekitWsUrl}`,
    `LIVEKIT_API_KEY=${selected.livekitApiKey}`,
    `LIVEKIT_API_SECRET=${selected.livekitApiSecret}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.error('LiveKit probe credentials written');
