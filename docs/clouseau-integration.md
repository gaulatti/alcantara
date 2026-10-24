# Clouseau integration status

This is installation preparation, not a working CI acceptance gate. The resumed
audit on 2026-10-24 refreshed protected central Clouseau main to
`7d350031a5172282fae462cdaa2416c424c5c16f`, engine content digest
`495da50549927a87e46227504505278932c6b437a67a1eeffddb5c3abb8f9768`.
The authoritative interface is
[Clouseau local review](https://github.com/gaulatti/clouseau/blob/7d350031a5172282fae462cdaa2416c424c5c16f/docs/local-review.md)
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
gate. Native tooling is Jest/Istanbul for backend coverage and Vitest/V8 for
frontend coverage. The preparation branch adds native frontend instrumentation;
both package configurations enforce exact 100% line and branch coverage and fail
while application counters remain uncovered.

At this base, the corrected inventory has 111 executable backend application
files plus one declaration-only file, and 187 frontend application files.
Declaration-only files and colocated tests are not application code. New tests
do not narrow that inventory. These counts establish scope, not a coverage pass.

The clean-base backend measurement used Node 22.22.0, pnpm 9.15.9, Prisma
generation, and the repository's Jest command with native JSON and JSON-summary
coverage reporters. All 55 suites and 323 tests passed. Native application
coverage was **4,542/8,040 lines** and **3,405/6,662 branches**, below the required
exact 100%. The report contained 112 entries, including a declaration-only entry
that the shared checker rejects; shared coverage acceptance did not pass.
Frontend type generation completed, but TypeScript initially failed with 16
existing diagnostics. The resumed branch repairs those type contracts without
changing output behavior: Web Audio buffers identify their actual ArrayBuffer
backing, optional browser media capture is declared explicitly, Redux actions
satisfy the installed Redux contract, sequence duration accumulation is numeric,
and unsupported renderer props are no longer read or passed. Node 22 frontend
type generation, TypeScript and production build then passed. Complete exact
coverage remains below 100%.

The default frontend test run passed 144 tests and timed out on two. A complete
rerun with at most two workers passed all 36 files and 146 tests without changing
tests, assertions, or timeouts. Both logs were retained. This distinguishes the
resource-sensitive test run from the original typecheck and coverage gaps.

The resumed work adds tests at actual public boundaries: Program rendering and
SSE/poll reconciliation, Preview isolation, scene cuts and transition timing,
audio playback/fades and analyser output, countdown activation authority,
caption replacement, real Redux logout, persisted sequences, session lifecycle,
API error handling, and backend transaction/scene/chart/upload/WebSocket paths.
Two existing Node-test files were not discovered by the frontend's Vitest
command. Their assertions now run through that supported runner, including the
out-of-order staging regression.

The session tests demonstrated a real malformed-expiry defect before repair:
`Date.parse` could return `NaN`, which escaped the old expiry comparison and
reused a cached local-test token. The finite-expiry validation now rejects it
and obtains a fresh session. The failing-before and passing-after evidence is
retained outside the checkout. No production credential or provider key is used.

Run the native gates from the repository root:

```sh
pnpm --dir backend run test:cov --runInBand
pnpm --dir backend run test:e2e
pnpm --dir frontend run test:coverage
pnpm --dir frontend run typecheck
pnpm --dir frontend run build
```

Use the repository's Node 22 and pnpm 9 toolchain. Native reports are written to
the ignored package `coverage/` directories. A failed exact-coverage command is
an installation blocker even when all behavioral tests passed. Coverage output
is diagnostic data; no consumer-specific coverage checker or translated report
is installed.

At the resumed verification checkpoint, all 509 frontend tests across 67 files
passed, and frontend typechecking and the production build passed. Native V8
coverage included all 187 application files and measured **13,742/34,409 lines**
and **3,217/4,079 branches**. The latest complete backend coverage measurement
passed 692 unit cases across 65 suites and measured **6,407/8,040 lines** and
**4,984/6,662 branches**. Both exact-coverage commands failed honestly. Later
focused test additions are not silently included in those frozen measurements.
The subsequent unit-only checkpoint passed all 703 cases across the same 65
suites. Backend end-to-end tests require `DATABASE_URL` to name a migrated,
isolated local PostgreSQL database called `alcantara_ci`; the guards reject a
different host or database.

The complete backend end-to-end inventory now builds the actual candidate before
testing it: **19 cases across all seven suites passed** against a dedicated local
PostgreSQL 17 database after applying every migration. The application smoke test
boots the actual compiled entry point under Node 22, including native ESM
dependencies and the production Fastify adapter, and exercises health, normal
local-session issuance, the real global guard, protected PostgreSQL reads and
viewer mutation denial over HTTP. The destination tests start their own local
Alana fixture and seed and clean their own fictional program/catalog state;
they do not require an already running application or production credentials.
The original missing-test-fixture failures are retained. The actual authenticated
Prometheus scrape also passed the existing CI's pinned Prometheus 3.9.0
`promtool check metrics` parser.

Native TypeScript branch accounting still needs a producer-level investigation:
the default Jest/Istanbul and native Jest V8 reports include emitted decorator
metadata alternatives at original constructor lines. These are not repaired by
artificially erasing imported classes or editing counters. Any adopted producer
must instrument actual source through standard tooling, retain complete native
maps and preserve real Nest dependency injection and the end-to-end tests.

## Shared capabilities required before acceptance

1. The local recipe requires a single native coverage report and a single source
   directory. Its Istanbul inventory recursively includes every JS/TS file under
   that directory, including colocated tests, and has no supported multi-root
   application inventory. Alcantara needs complete separate backend/frontend
   inventories and native reports without dependencies, test code, or uncovered
   application files being misclassified. Do not supply a backend-only recipe,
   fabricate a combined report, or copy a consumer coverage checker.
   The initial backend report included `runtime-secret-contract.d.ts` with
   empty counters and was rejected. Native Jest collection now omits only
   declaration-only files, producing 111 executable source entries. That repair
   preserves the full application inventory; the shared multi-root and colocated
   test inventory limitation remains.
2. No recipe, trusted CI policy, or enrolled signing identity exists on the
   accepted base. The released local CLI requires those accepted-base inputs
   and provides no initial-installation review/enrollment command. Proposed
   configuration cannot authorize itself. Initial trust enrollment and ordinary
   application approval must remain separate.
3. The released shared integration still documents fixed reviewed engine pins;
   no automatic protected-main engine resolver is available in the accepted
   interface. The refreshed release does include code-owner-only automatic merge,
   review convergence, and explicit completeness manifests. Those central
   capabilities must not be listed as missing, but their hosted consumer path
   has not yet been installed or proved here. Consumer-specific replacements
   remain outside the shared contract.

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
adding bypasses, or removing unrelated controls. The current release can enforce
the ownership rule; unattended merge remains uninstalled pending the complete
verification, accepted-base bootstrap and trusted CI integration.

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
