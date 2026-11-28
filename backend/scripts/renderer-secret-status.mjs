import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// Says which renderer keys the runtime secret holds (gaulatti/alcantara#884), as one JSON line: whether the fleet key
// and the old shared key are present, and the ids of the programs with a key. Never a key's value or length, and never
// the payload. Exit 0: read. Exit 1: unavailable or invalid.
const require = createRequire(import.meta.url);
const {
  parseRuntimeSecretPayload,
} = require('../src/config/runtime-secret-contract.js');

/** What the line says, from a parsed secret. */
export function rendererSecretStatus(secret) {
  return {
    fleetKey: typeof secret.webrtcFleetKey === 'string' && secret.webrtcFleetKey.length > 0,
    sharedKey: typeof secret.webrtcRendererKey === 'string' && secret.webrtcRendererKey.length > 0,
    programKeys: Object.keys(secret.webrtcProgramKeys ?? {}).sort(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const secretId = process.env.ALCANTARA_CONFIG_SECRET_ID?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!secretId || !region) {
    console.error('ALCANTARA_CONFIG_SECRET_ID and AWS_REGION are required');
    process.exit(1);
  }
  try {
    const response = await new SecretsManagerClient({ region }).send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    process.stdout.write(
      `${JSON.stringify(rendererSecretStatus(parseRuntimeSecretPayload(response.SecretString)))}\n`,
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
}
