import { createRequire } from 'node:module';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// Writes the return runner's renderer key from the runtime secret to stdout, as an env line, for the deploy to place
// in a 0600 file. Exit 0: written. Exit 3: the secret has no renderer key. Exit 1: unavailable or invalid. Never logs
// a key, a secret or the payload.
const require = createRequire(import.meta.url);
const {
  parseRuntimeSecretPayload,
} = require('../src/config/runtime-secret-contract.js');

const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
const region = process.env.AWS_REGION?.trim();
if (!secretId || !region) {
  console.error('ALCANTARA_CONFIG_SECRET_ID and AWS_REGION are required');
  process.exit(1);
}

let key;
try {
  const response = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  key = parseRuntimeSecretPayload(response.SecretString).webrtcRendererKey;
} catch (error) {
  // The contract's messages name fields, never values.
  console.error(
    error instanceof Error
      ? error.message
      : 'Alcantara runtime configuration is unavailable',
  );
  process.exit(1);
}
if (!key) {
  console.error('The runtime secret has no renderer key');
  process.exit(3);
}
if (/[\r\n'"]/.test(key)) {
  console.error('The renderer key cannot be written to an env file');
  process.exit(1);
}
process.stdout.write(`WEBRTC_RENDERER_KEY=${key}\n`);
