import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

interface SecretClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

interface DatabaseEnvironment {
  ARAUCO_SECRET_ID?: string;
  AWS_DEFAULT_REGION?: string;
  AWS_REGION?: string;
  DATABASE_URL?: string;
  [key: string]: string | undefined;
}

interface DatabaseSecretPayload {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

const parsePayload = (
  secretString: string | undefined,
): DatabaseSecretPayload => {
  let payload: unknown;
  try {
    payload = JSON.parse(secretString ?? '');
  } catch {
    throw new Error('Arauco database configuration is malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Arauco database configuration is malformed');
  }
  const candidate = payload as Record<string, unknown>;
  const port = Number(candidate.port);
  if (
    typeof candidate.username !== 'string' ||
    !candidate.username ||
    typeof candidate.password !== 'string' ||
    !candidate.password ||
    typeof candidate.host !== 'string' ||
    !candidate.host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof candidate.dbname !== 'string' ||
    !candidate.dbname
  ) {
    throw new Error('Arauco database configuration is malformed');
  }
  return {
    username: candidate.username,
    password: candidate.password,
    host: candidate.host,
    port,
    dbname: candidate.dbname,
  };
};

const databaseUrl = (payload: DatabaseSecretPayload): string => {
  const url = new URL('postgresql://database.invalid');
  url.username = payload.username;
  url.password = payload.password;
  url.hostname = payload.host;
  url.port = String(payload.port);
  url.pathname = `/${payload.dbname}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
};

/** Resolve Arauco credentials before migrations or Nest construct providers. */
export async function loadDatabaseSecret(
  environment: DatabaseEnvironment = process.env,
  client?: SecretClient,
): Promise<void> {
  const secretId = environment.ARAUCO_SECRET_ID?.trim();
  if (!secretId) {
    if (!environment.DATABASE_URL?.trim()) {
      throw new Error('ARAUCO_SECRET_ID or DATABASE_URL is required');
    }
    return;
  }
  const region = (
    environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION
  )?.trim();
  if (!region) throw new Error('AWS_REGION is required');
  const secrets = client ?? new SecretsManagerClient({ region });
  let response: { SecretString?: string };
  try {
    response = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
  } catch {
    throw new Error('Arauco database configuration is unavailable');
  }
  environment.DATABASE_URL = databaseUrl(parsePayload(response.SecretString));
}
