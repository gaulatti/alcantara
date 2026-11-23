/**
 * gaulatti/alcantara#223: the deploy starts the new image once as a throwaway
 * candidate, checks that it answers, and removes it before it touches the
 * running backend. A candidate shares the production database with the live
 * instance, so it boots the whole HTTP application and loads its
 * configuration and secrets, but writes nothing, claims nothing and schedules
 * nothing:
 *
 * - every database session it opens is read-only (PostgreSQL rejects any
 *   write; see `createPostgresAdapter`);
 * - the start-up writers and the schedulers skip their work: the rundown
 *   reset and its one-second start poll, the default program state, the
 *   Palazzo telemetry supervisor, the media-asset reconciliation, the media
 *   analysis queue, the hourly backup, the chart poll and the similarity
 *   refresh.
 *
 * Only the deploy sets this, and only on the candidate container. It is a
 * start-up mode, not a behaviour flag: unset means a normal instance, `1`
 * means a candidate, anything else fails start-up.
 */
export const DEPLOY_CANDIDATE_ENV = 'ALCANTARA_DEPLOY_CANDIDATE';

export function isDeployCandidate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[DEPLOY_CANDIDATE_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${DEPLOY_CANDIDATE_ENV} must be 1 or unset`);
}

/**
 * PostgreSQL session setting that makes every transaction of the session
 * read-only, so a write fails with "cannot execute ... in a read-only
 * transaction" instead of changing a row.
 */
export const READ_ONLY_SESSION_OPTION = '-c default_transaction_read_only=on';
