import { isProductionEnvironment } from './config/local-media';
import { validateProgramTemplateOrigins } from './config/runtime-secret-contract';
import { MCP_PUBLIC_ORIGIN } from './mcp/mcp.constants';

/** Origins whose browser pages may call the API. Read when the app starts, after runtime secrets load. */
export function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (
    process.env.ALLOWED_ORIGINS ??
    process.env.FRONTEND_ORIGIN ??
    ''
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const templateOrigins = validateProgramTemplateOrigins(
    process.env.PROGRAM_TEMPLATE_ORIGINS ?? '',
  );

  return new Set<string>([
    // The API's own origin: the MCP consent page (gaulatti/bastille#34) is
    // served from it and posts its form back to it, and a same-origin request
    // is not a cross-origin one, so allowing it grants nothing new.
    MCP_PUBLIC_ORIGIN,
    'https://alcantara.gaulatti.com',
    'https://alcantara.dev',
    'https://alcantara.gt',
    'https://fifthbell.com',
    'https://cdn.fifthbell.com',
    // The desktop console's WebView (the Tauri app, gaulatti/bastille#32):
    // macOS serves its page from tauri://localhost, Windows and Linux from
    // http://tauri.localhost. Only a native app sends these, and a native app
    // is not bound by CORS at all, so allowing them grants nothing new.
    'tauri://localhost',
    'http://tauri.localhost',
    ...configuredOrigins,
    ...templateOrigins,
  ]);
}

/** A page served from this machine: the local stack's browser origins, never production's. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * The API's CORS policy: the listed origins, and outside production a page served from this machine. The opaque
 * "null" origin is never allowed. An origin outside the policy is refused without an error: the response simply
 * carries no CORS headers, so the browser blocks it, instead of the request failing with a server error.
 */
export function corsOptions(
  environment: Record<string, string | undefined> = process.env,
) {
  const allowedOrigins = getAllowedOrigins();
  const production = isProductionEnvironment(environment);
  return {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => {
      callback(
        null,
        !origin ||
          allowedOrigins.has(origin) ||
          (!production && LOCAL_ORIGIN.test(origin)),
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Renderer-Key',
    ],
  };
}
