/**
 * Public identifiers, not secrets, and code-owned: the API origin the console
 * calls (API_BASE_URL) and the Cognito domain and app client the console signs
 * in with (COGNITO_DOMAIN, COGNITO_CLIENT_ID). Cognito authenticates; Pompeii
 * authorizes. Changing any of these is a code change, never configuration.
 */
export const MCP_PUBLIC_ORIGIN = 'https://api.alcantara.gaulatti.com';
export const MCP_RESOURCE_URL = `${MCP_PUBLIC_ORIGIN}/mcp`;
export const MCP_RESOURCE_METADATA_URL = `${MCP_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`;
export const MCP_REGISTRATION_URL = `${MCP_PUBLIC_ORIGIN}/register`;
export const COGNITO_HOSTED_DOMAIN = 'https://buendia.gaulatti.com';
export const COGNITO_ISSUER =
  'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_8O5vq7xVJ';
/** The console's public Cognito app client (authorization code + PKCE, no secret). */
export const MCP_SHARED_CLIENT_ID = '45r95gg8h69i9vss3t3dbt2us';
export const MCP_OAUTH_SCOPES = ['openid', 'email', 'profile'] as const;

export const MCP_SERVER_NAME = 'alcantara';
export const MCP_SERVER_VERSION = '1.0.0';

export const MCP_LIMITS = {
  /** A request body larger than this is refused before authentication. */
  maxRequestBytes: 256 * 1024,
  /** An Authorization header larger than this is refused without asking Pompeii. */
  maxAuthorizationBytes: 8 * 1024,
  /** How long one Pompeii answer is reused for the same header. */
  decisionCacheMs: 30_000,
  decisionCacheEntries: 1024,
  /** Pompeii calls in flight at once; beyond this the endpoint answers 503. */
  maxConcurrentDecisions: 32,
  /** Refused credentials allowed per client key per window before 429. */
  failuresPerWindow: 20,
  failureWindowMs: 60_000,
  failureClients: 4096,
  /** Redirect URIs a registration may list. */
  maxRegistrationUris: 8,
  maxRegistrationUriLength: 2048,
  /** Capabilities returned per list_capabilities page. */
  capabilityPageDefault: 25,
  capabilityPageMax: 100,
} as const;

/**
 * Limits of the action framework (gaulatti/alcantara#212). Code-owned: a limit
 * change is a code change, never configuration.
 */
export const MCP_ACTION_LIMITS = {
  /** Window of the per-identity call limits. */
  windowMs: 60_000,
  /** Real runs per identity per window, by tier. Dry runs are not counted. */
  perWindow: { W: 60, A: 6, D: 3 },
  /** Least time between two A runs by one identity on one program. */
  onAirSpacingMs: 10_000,
  /** How long a key's outcome is replayed. In memory: lost on restart. */
  idempotencyTtlMs: 10 * 60_000,
  /** Outcomes held at once; the oldest is evicted first. */
  idempotencyEntries: 1024,
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 128,
  confirmMax: 2048,
} as const;

/**
 * Longest a wait_for_change call may hold a request open
 * (gaulatti/alcantara#214). Code-owned, like every limit here.
 */
export const MCP_WAIT_MAX_SECONDS = 30;

/** Bounds of the R-tier radio tools (gaulatti/alcantara#214). */
export const MCP_READ_LIMITS = {
  /** wait_for_change calls one identity may hold open at once. */
  concurrentWaitsPerIdentity: 2,
  /** Changes kept per program for since_sequence; older ones are dropped. */
  changeBuffer: 64,
  /** get_as_run: widest window, most rows and the default row count. */
  asRunWindowDays: 7,
  asRunLimitMax: 500,
  asRunLimitDefault: 100,
  /** get_royalty_summary: widest window (one quarter) and most songs listed. */
  royaltyWindowDays: 92,
  royaltySongsMax: 500,
  /** search_songs: most songs returned. */
  songSearchMax: 50,
  songSearchDefault: 20,
  /** get_rundown: clocked logs that get a preflight summary. */
  rundownPreflightMax: 10,
} as const;
