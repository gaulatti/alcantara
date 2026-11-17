/**
 * Local media store guard (gaulatti/alcantara#206).
 *
 * A local or test run must never write to, read from or hand out URLs for a
 * real S3 bucket. Outside production the media bucket is only usable through
 * MEDIA_S3_ENDPOINT pointing at a local store (the Compose localstack), and
 * LOCAL_MEDIA_PUBLIC_BASE_URL names where that store serves its objects. In
 * production neither variable may be set. Errors name the variable, never its
 * value.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export const MEDIA_S3_ENDPOINT = 'MEDIA_S3_ENDPOINT';
export const LOCAL_MEDIA_PUBLIC_BASE_URL = 'LOCAL_MEDIA_PUBLIC_BASE_URL';

/** The variables this guard reads, taken from a Nest ConfigService. */
export function localMediaEnvironment(config: {
  get<T = string>(name: string): T | undefined;
}): Environment {
  const value = (name: string) => {
    const raw = config.get<unknown>(name);
    return typeof raw === 'string' ? raw : undefined;
  };
  return {
    NODE_ENV: value('NODE_ENV'),
    MEDIA_S3_BUCKET: value('MEDIA_S3_BUCKET'),
    [MEDIA_S3_ENDPOINT]: value(MEDIA_S3_ENDPOINT),
    [LOCAL_MEDIA_PUBLIC_BASE_URL]: value(LOCAL_MEDIA_PUBLIC_BASE_URL),
  };
}

function read(environment: Environment, name: string): string {
  return (environment[name] ?? '').trim();
}

export function isProductionEnvironment(environment: Environment): boolean {
  return read(environment, 'NODE_ENV') === 'production';
}

/**
 * A host only a local machine or its Compose network can reach: loopback, a
 * *.localhost name, or a single-label service name such as `localstack`.
 * Every public host has at least one dot.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return !host.includes('.') && !host.includes(':');
}

function parseLocalUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return isLocalHostname(url.hostname) ? url : null;
}

/**
 * Refuses a start-up that could reach a real bucket from a local run, or that
 * carries a local-only media variable into production.
 */
export function assertLocalMediaSafety(
  environment: Environment = process.env,
): void {
  const endpoint = read(environment, MEDIA_S3_ENDPOINT);
  const publicBase = read(environment, LOCAL_MEDIA_PUBLIC_BASE_URL);

  if (isProductionEnvironment(environment)) {
    for (const [name, value] of [
      [MEDIA_S3_ENDPOINT, endpoint],
      [LOCAL_MEDIA_PUBLIC_BASE_URL, publicBase],
    ] as const) {
      if (value) {
        throw new Error(`${name} must not be set when NODE_ENV=production`);
      }
    }
    return;
  }

  if (endpoint && !parseLocalUrl(endpoint)) {
    throw new Error(
      `${MEDIA_S3_ENDPOINT} must point at a local media store outside production`,
    );
  }
  if (publicBase && !parseLocalUrl(publicBase)) {
    throw new Error(
      `${LOCAL_MEDIA_PUBLIC_BASE_URL} must point at a local media store outside production`,
    );
  }
  if (read(environment, 'MEDIA_S3_BUCKET') && !endpoint) {
    throw new Error(
      `MEDIA_S3_BUCKET is set outside production without ${MEDIA_S3_ENDPOINT}; a local run may only use a local media store`,
    );
  }
}

/** The local S3 endpoint, or undefined in production or when unset. */
export function readMediaS3Endpoint(
  environment: Environment,
): string | undefined {
  if (isProductionEnvironment(environment)) return undefined;
  const endpoint = read(environment, MEDIA_S3_ENDPOINT);
  return endpoint && parseLocalUrl(endpoint) ? endpoint : undefined;
}

/**
 * The base URL the local store serves the bucket's objects from, without a
 * trailing slash, or undefined in production or when unset.
 */
export function readLocalMediaPublicBase(
  environment: Environment,
): string | undefined {
  if (isProductionEnvironment(environment)) return undefined;
  const base = read(environment, LOCAL_MEDIA_PUBLIC_BASE_URL);
  if (!base || !parseLocalUrl(base)) return undefined;
  return base.replace(/\/+$/, '');
}

/**
 * Whether a media URL belongs to the local store's public base. Always false
 * in production, so production keeps accepting only the managed bucket's
 * amazonaws hosts.
 */
export function isLocalMediaUrl(url: URL, environment: Environment): boolean {
  const base = readLocalMediaPublicBase(environment);
  if (!base) return false;
  const baseUrl = new URL(`${base}/`);
  return (
    url.protocol === baseUrl.protocol &&
    url.host === baseUrl.host &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith(baseUrl.pathname)
  );
}
