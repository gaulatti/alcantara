# Clouseau integration status

This is installation preparation, not a working CI acceptance gate. The audit
on 2026-10-24 used protected central Clouseau main
`4f441cb5abba0600cfad1b86adb561f347e93d96`, engine content digest
`efc1e48363f73edd317dc61a231ab2fa01b0808d8a53ff6c0f6a9c7c2a5c3691`.
The authoritative interface is
[Clouseau local review](https://github.com/gaulatti/clouseau/blob/4f441cb5abba0600cfad1b86adb561f347e93d96/docs/local-review.md)
and its immutable source, not an unreleased development branch.

## Installed locally

Bastille's startup updater refreshes the public shared Clouseau installation
and user-wide skill independently of CI. Repository instructions require local
review, investigation, repair, final-revision review, and signed-evidence
publication before a ready PR. Local review uses authenticated Codex or Claude
Code accounts and needs no CI provider API key.

The current managed-standard refresh succeeded at Bastille
`6fab28b11662a6b1b6f1fa0c3e0273278538d721`. Private Bastille availability is
not a prerequisite: the checked-in rules remain usable, and the public Clouseau
bootstrap still runs. Global installation creates no provider secrets or CI jobs.

## Existing repository verification

The accepted default branch audited was
`8a4cb2a2132810e36ca3e73ff2147ae7f5207771`. The project is a pnpm workspace
with a NestJS/Fastify/Prisma backend, React Router/Vite frontend, and TypeScript
AWS infrastructure definitions. Existing CI uses Node 22 and pnpm 9.

The backend PR workflow installs the workspace with a frozen lockfile, generates
Prisma, applies migrations to disposable PostgreSQL 17, runs Jest, exercises
metrics/media-label concurrency end-to-end tests, tests deployment contracts,
builds the backend and infrastructure definitions, and parses an authenticated
Prometheus scrape with `promtool`. Frontend tests currently execute in the
production deployment workflow; there is no equivalent protected frontend PR
gate. Native tooling is Jest/Istanbul for backend coverage and Vitest for frontend
tests. Frontend coverage instrumentation is not installed.

At this base, `backend/src` has 112 executable application files and
`frontend/app` has 187, excluding declaration-only files and 93 colocated test
files. These counts establish scope, not a claim that coverage passed.

The clean-base backend measurement used Node 22.22.0, pnpm 9.15.9, Prisma
generation, and the repository's Jest command with native JSON and JSON-summary
coverage reporters. All 55 suites and 323 tests passed. Native application
coverage was **4,542/8,040 lines** and **3,405/6,662 branches**, below the required
exact 100%. The report contained 112 entries, including a declaration-only entry
that the shared checker rejects; shared coverage acceptance did not pass.
Frontend type generation completed, but TypeScript failed with 16 existing
diagnostics. No all-application verification or exact-coverage success is claimed.

The default frontend test run passed 144 tests and timed out on two. A complete
rerun with at most two workers passed all 36 files and 146 tests without changing
tests, assertions, or timeouts. Both logs were retained. This distinguishes the
resource-sensitive test run from the unresolved typecheck and coverage gaps.

## Shared capabilities required before acceptance

1. The local recipe requires a single native coverage report and a single source
   directory. Its Istanbul inventory recursively includes every JS/TS file under
   that directory, including colocated tests, and has no supported multi-root
   application inventory. Alcantara needs complete separate backend/frontend
   inventories and native reports without dependencies, test code, or uncovered
   application files being misclassified. Do not supply a backend-only recipe,
   fabricate a combined report, or copy a consumer coverage checker.
   The real backend report also includes `runtime-secret-contract.d.ts` with
   empty counters; the shared checker rejects that declaration entry. Native
   declaration/report handling must preserve complete executable source coverage.
2. No recipe, trusted CI policy, or enrolled signing identity exists on the
   accepted base. The released local CLI requires those accepted-base inputs
   and provides no initial-installation review/enrollment command. Proposed
   configuration cannot authorize itself. Initial trust enrollment and ordinary
   application approval must remain separate.
3. The released shared integration documents fixed reviewed engine pins. It has
   no automatic protected-main engine resolver and no code-owner-only automatic
   merge policy satisfying the requested ownership rules. Consumer-specific
   replacements are outside the shared contract.

## Repository controls still required

The accepted-base audit found no CODEOWNERS, branch protection, or repository
rulesets. GitHub lists `gaulatti` as the sole collaborator and administrator;
accepted-branch history identifies the same existing maintainer. The proposed
`.github/CODEOWNERS` therefore assigns every path and the ownership definition
itself to `@gaulatti`. No existing path or team ownership was replaced. This
proposal grants no authority until accepted on the protected base.

Auto-merge is enabled, but Actions approving reviews are disabled. No Clouseau
provider secret is installed. Required checks and fresh approval protection
must be added through the released installation path without waiving tests,
adding bypasses, or removing unrelated controls. The released controller cannot
yet enforce the required ownership rule, so unattended merge is not installed.

No ready installation PR or proof PR has been opened: initial local review and
complete native coverage cannot yet satisfy the released protocol. No approval,
protected merge, receipt reuse, paid CI review, or deployment is claimed.

## Deployment and documentation

Backend and frontend push-to-main workflows perform real production AWS/SSM/S3
operations for their respective path filters. A coverage repair under application
paths would therefore require deployment authorization before a deployable PR.
No production operation was run for this installation audit.

The last observed successful deployments both used
`43190938039d975f83751efddde20fc1e23456b0`:
[backend run 38093068080](https://github.com/gaulatti/alcantara/actions/runs/38093068080)
and [frontend run 38093068071](https://github.com/gaulatti/alcantara/actions/runs/38093068071).
They are historical delivery evidence and do not establish deployment of the
newer audited default branch or live health. No deployment-bound documentation
publisher is installed. The public repository has the wiki feature enabled,
but the startup updater could not access its wiki remote. In-repository
documentation is maintained until a real wiki and supported publication route
are available. Documentation publication and ticket closeout remain unproved.
