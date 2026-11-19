# MCP action framework

Every MCP tool that is not a read (tier W, A or D) runs through one executor,
`McpActionExecutor` (`backend/src/mcp/mcp-action.executor.ts`), bound under
`MCP_ACTION_EXECUTOR` in `McpModule`. Tools are specs (`McpToolSpec`); the
executor knows no concrete tool. Tracker: gaulatti/alcantara#210, ticket #212.

| Tier | Meaning | Dry run | Confirm | Re-authorization |
|---|---|---|---|---|
| R | read | no | no | cached decision (30 s) |
| W | reversible write | where the spec has one | no | cached decision |
| A | on-air action | where the spec has one | yes | Pompeii asked again, no cache |
| D | destructive | where the spec has one | yes | Pompeii asked again, no cache |

The registry checks the permission (again, at call time) and, for A and D,
re-authorizes with Pompeii before it hands a call to the executor. The
executor does not repeat either.

## Arguments the framework adds

| Field | Where | Rule |
|---|---|---|
| `idempotency_key` | every W, A and D spec, required | 8 to 128 characters of `A-Za-z0-9._:-` |
| `dry_run` | specs that have a dry run | boolean |
| `confirm` | specs that have a confirm target (A and D) | the exact confirm string |

The registry advertises the extended input schema (tool listing and
`list_capabilities`). Unknown arguments are refused as `invalid`, including
`dry_run` on a spec without a dry run (a call that asks only to plan is never
turned into a real run).

## Order of checks

1. **Parse.** Strict zod parse of the spec's shape plus the framework fields.
   Failure: `invalid`.
2. **Rate limit.** Checked here, recorded only when the call goes on to run.
   Failure: `rate_limited` with `retry_after_seconds`. A call whose key already
   has a stored outcome for the same arguments skips this check, because a
   replay is not a new action.
3. **Dry run.** When `dry_run` is true: the spec's dry run is returned as
   `{dry_run: true, summary, affects, recoverable, onAir, confirm}` and
   nothing is written. `confirm` is the exact string to echo (present when the
   spec has a confirm target). A dry run consumes no idempotency key and
   records nothing in the limiter.
4. **Confirm.** When the spec has a confirm target, `confirm` must equal
   `"<id> <name>"` of the target as it is now. Missing: `confirm_required`.
   Different: `confirm_mismatch`.
5. **Idempotency.** See below. A key reused with different arguments:
   `idempotency_reuse`.
6. **Attribution.** For A and D, when `MCP_ATTRIBUTION` is bound, the run is
   wrapped in `attribution.run({principalId, via: 'mcp', client}, work)`. W runs
   directly, and so does everything when nothing is bound.
7. **Run.** The rate limit is recorded immediately before the run, in the same
   synchronous step as the last check, so concurrent calls cannot overspend it.
   A run that fails still counts: it may have acted.
8. **Store.** The outcome is stored under the key only after a successful run.
   A refusal or a thrown error stores nothing and leaves the key free.
9. **Audit and metric**, for every call, refused or not.

A refused call (parse, rate limit, confirm, idempotency) consumes no key, no
allowance and no on-air spacing.

## Rate limits

Code constants in `MCP_ACTION_LIMITS` (`mcp.constants.ts`); there is no
configuration and no override. A change is a code change.

| Tier | Per identity | Also |
|---|---|---|
| W | 60 runs per minute | |
| A | 6 runs per minute | at least 10 s between two runs on the same program (the `program_id` argument; no `program_id` is a program of its own) |
| D | 3 runs per minute | |

Identity is the Pompeii principal id, or the subject while the principal id is
null. Windows are sliding and per tier. Dry runs are not recorded and ignore
the on-air spacing; they are still refused while the per-minute allowance is
spent, so a spent allowance refuses everything of that tier until it frees.
`retry_after_seconds` is the time until the call would be allowed.

## Idempotency

- Keyed by identity, tool name and key: another identity or another tool never
  hits it.
- The same key with the same canonical arguments (key order is irrelevant)
  returns the stored outcome; the action does not run again and no allowance
  or spacing is consumed. Two simultaneous calls with one key run once.
- The same key with different arguments: `idempotency_reuse`.
- **Held in memory for 10 minutes and lost on a backend restart.** A retry
  after a restart runs again. A tools re-check their target (`stale_target`),
  so a replay of a stale plan fails. The registry appends a sentence saying so
  to the description of every A and D tool and capability.
- At most 1024 outcomes are held; the oldest is evicted first and expired ones
  are swept on every access.

## Audit line

`Logger('McpAudit')`, one line per call, `mcp.action ` followed by JSON:

| Field | Value |
|---|---|
| `identity` | principal id, or the subject when it is null |
| `tool`, `tier` | the spec's name and tier |
| `result` | `ok`, `dry_run`, or the refusal code (`unavailable` for an unexpected failure) |
| `dry_run` | whether the call asked for a dry run |
| `key` | first 12 hex characters of the SHA-256 of the idempotency key |
| `replayed` | true when the stored outcome was returned |
| `target`, `fields`, `count` | the spec's `McpAuditDetails`: an id, field names, a count |

Argument text, titles, confirm strings and key values are never logged.

## Metric

`alcantara_mcp_requests_total{tool,tier,result}`, a counter incremented once
per call (R calls by the registry, W, A and D calls by the executor).
`tool` is a registered spec name (`unknown` otherwise), `tier` is R, W, A or D,
and `result` is `ok`, `dry_run` or one of the closed error codes. No argument,
key or identity is ever a label. Operationally: a rising `rate_limited` on A
means a client is looping; `confirm_mismatch` and `stale_target` mean plans
went stale; `idempotency_reuse` means a client bug. `alcantara_mcp_auth_total`
(authentication) is separate.
