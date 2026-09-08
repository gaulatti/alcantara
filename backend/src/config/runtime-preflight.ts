import 'dotenv/config';
import { assertTestAuthSafety } from '../auth/test-auth.service';
import {
  loadRuntimeSecrets,
  validateRuntimeConfiguration,
} from './runtime-secrets';

async function preflight(): Promise<void> {
  assertTestAuthSafety();
  await loadRuntimeSecrets();
  validateRuntimeConfiguration();
  process.stdout.write('Alcantara runtime preflight passed\n');
}

void preflight().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown failure';
  process.stderr.write(`Alcantara runtime preflight failed: ${message}\n`);
  process.exitCode = 1;
});
