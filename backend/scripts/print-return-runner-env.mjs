import { createRequire } from 'node:module';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { rendererEnvLines } from './renderer-env.mjs';

// Writes a holder's renderer keys from the runtime secret to stdout, as env lines, for the deploy to place in a 0600
// file: the shared key while it is still accepted, the fleet key, and every program's key (the return runner) or, with
// `--program <id>`, that program's key (a contribution worker). Exit 0: written. Exit 3: the secret has no renderer key
// for this holder. Exit 1: unavailable or invalid. Never logs a key, a secret or the payload.
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
const programFlag = process.argv.indexOf('--program');
const program = programFlag === -1 ? undefined : process.argv[programFlag + 1];
if (programFlag !== -1 && !program) {
  console.error('--program needs a program id');
  process.exit(1);
}

let secret;
try {
  const response = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  secret = parseRuntimeSecretPayload(response.SecretString);
} catch (error) {
  // The contract's messages name fields, never values.
  console.error(
    error instanceof Error
      ? error.message
      : 'Alcantara runtime configuration is unavailable',
  );
  process.exit(1);
}
const { lines, problem } = rendererEnvLines(secret, { program });
if (problem) {
  console.error(problem);
  process.exit(1);
}
if (!lines.length) {
  console.error('The runtime secret has no renderer key');
  process.exit(3);
}
process.stdout.write(`${lines.join('\n')}\n`);
