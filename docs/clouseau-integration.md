# Clouseau integration status

This branch prepares the installation; it is not a working protected acceptance
path yet. The original installation audit used released Clouseau
`c4e07381a288fc74200fd712f04ac3265ef2184a`, content digest
`1eaed29fd22aa45f111b5a8ed37da2299576e303b80743ab846ef53848c680e7`.
Its immutable cache checkout was verified clean. The local AI policy correction
below follows released Clouseau `1df7a5fe244ac837023caa0e14a22412d123f12c`,
content digest `5f5afe9aa60dfb41418625e06c7a8405c143c4f964845079ee1c81b97658030f`;
this documentation change is not a new application review or coverage result. Use the
[released interface](https://github.com/gaulatti/clouseau/blob/1df7a5fe244ac837023caa0e14a22412d123f12c/docs/local-review.md),
not an unmerged central branch or a copied review engine.

## Local installation and application scope

Bastille's startup updater refreshes the public shared Clouseau source and
user-wide skill independently of CI. The managed-standard refresh succeeded at
Bastille `6fab28b11662a6b1b6f1fa0c3e0273278538d721`. Private Bastille access
is not required: checked-in standards remain usable and the public bootstrap
still runs. The global installer creates no Actions jobs, provider secrets,
signing identities, or branch rules. Supported local harnesses are authenticated
Codex and Claude Code; they require no CI provider API keys.

Both agent instruction files require reading the accepted requirement and
purpose, complete verification, local shared review, investigation and repairs,
review of the final changed revision, and eligible signed-evidence publication
before opening a ready PR with the returned marker in its initial body. Local
AI review is required before every PR regardless of coverage percentage, a
failing coverage command or unavailable/invalid coverage. Real verification
outcomes and the AI quality decision are separate claims.

The audited accepted default branch was
`8a4cb2a2132810e36ca3e73ff2147ae7f5207771`. This pnpm workspace uses Node 22
and pnpm 9. Product application inventory comprises every runtime source under
`backend/src` (NestJS/Fastify/Prisma, 112 native entries including a purely typed
module) and `frontend/app` (React Router/Vite, 187 files). Colocated tests and
`.d.ts` declarations are not application code. The separate `infra/aws` package
contains deployment definitions; its existing local static tests and TypeScript
build remain verification requirements, separately from product runtime coverage.
No CDK CLI or AWS operation is part of the local recipe.

## Local AI quality and technical acceptance

The released local runner records real command outcomes, coverage counts and
unavailable/invalid coverage diagnostics, then runs AI review regardless of
coverage percentage or a failing coverage command. It never turns those outcomes
into fabricated passing verification. A passing AI quality review may produce
eligible signed reuse evidence even with partial coverage. That evidence does
not authorize technical acceptance or merge: independent CI still requires all
mandatory tests and exact 100% line and branch coverage. Demonstrated defects,
deceptive tests and missing material behavioral context remain review blockers.

This release removes the former coverage prerequisite to local AI review. It
does not resolve this repository's missing accepted-base recipe/policy, signing
enrollment and initial trust authorization, complete-source/evidence capacity
limits, or incomplete hosted integration. Use the released
[initial-installation procedure](https://github.com/gaulatti/clouseau/blob/1df7a5fe244ac837023caa0e14a22412d123f12c/docs/initial-installation.md)
where required; proposed configuration and an unsigned diagnostic report cannot
authorize approval. No application AI verdict or receipt reuse is proved by
this documentation correction.

## Native verification recipe

The proposed `.clouseau-local.json` uses released version 2: separate untouched
native Istanbul JSON reports and explicit nonoverlapping product source roots.
The shared parser now supports this inventory, colocated test exclusions, and
genuine empty native maps for type-only modules. Earlier single-root and
empty-map limitations no longer apply to this audited release.

Run the complete local recipe independently of Actions:

```sh
node scripts/verify-local.mjs
```

Prerequisites are installed workspace dependencies, Node 22, pnpm 9, and a local
Docker context exposed through a Unix socket. The verifier creates one unique,
disposable PostgreSQL 17 container with an in-memory data directory and an
explicit free localhost port, applies the real migrations, runs all native tests,
coverage, type checks and builds, then parses the authenticated e2e metrics scrape
with the existing CI's pinned Prometheus 3.9.0 `promtool`. It always removes only
its own container. It fails if any command fails, and removes prior native
reports and the metrics scrape before the run. It contains no provider settings,
production credentials, review engine, or consumer-specific coverage checker.

Its actual commands are:

```sh
pnpm --dir backend run prisma:generate
pnpm --dir backend run db:migrate:prisma
pnpm --dir backend run test:cov --runInBand
pnpm --dir backend run test:e2e --runInBand
pnpm --dir backend run test:deployment
pnpm --dir frontend run typecheck
pnpm --dir frontend run build
pnpm --dir frontend run test:coverage
pnpm --dir infra/aws exec jest --runInBand
pnpm --dir infra/aws run build
```

Native reports remain in ignored package `coverage/` directories. Exact 100%
lines and branches are enforced by both native test commands and the shared
Clouseau CI coverage parser. Their failure is recorded without suppressing local
AI review. Neither application root can compensate for the other's gaps.
The accepted protected base must supply this recipe before ordinary local
review; proposed configuration cannot authorize itself.

Backend coverage instruments authored TypeScript with native Istanbul before
real TypeScript compilation. This preserves actual source branches while keeping
Nest constructor metadata, instead of counting compiler-generated metadata
alternatives as application decisions. The same producer runs unit and e2e
contexts. The stock Node child entry point uses an instrumented compiled tree;
its untouched native counters are merged with Istanbul's standard map merger
before Jest emits the native report. Normal e2e execution continues to build and
boot the uninstrumented candidate. Source-map tests check authored locations,
real branches, constructor metadata, type-only modules, and a real Node child
with identical native statement and branch maps. No counters are reinterpreted
or removed. Frontend coverage uses the native Vitest V8 provider with its supported
`experimentalAstAwareRemapping` option. The [versioned coverage guide](https://github.com/vitest-dev/vitest/blob/v3.2.7/docs/guide/coverage.md)
and installed types document this source-aware producer; its complete 187-file
report is accepted by the shared inventory checker. It measures authored code
and exposes real branch alternatives instead of counting comments, type-only
syntax and JSX formatting as executable lines. No coverage is waived.

The disposable-database backend orchestration was executed end to end: Prisma
generation/migrations, application build, five native-producer fixtures, all
1,513 combined native tests, all 34 normal e2e tests, 18 deployment-contract
tests, and the real authenticated metrics parser passed. Its unique PostgreSQL
container was removed. The command returned failure because exact coverage is
still below 100%; passing behavioral tests do not waive that requirement.

The accepted recipe runs the backend subcommand with its own database lifecycle,
then uses separate supported argument arrays for frontend type checking, build,
coverage and static infrastructure verification. This keeps each command within
the shared runner's per-command timeout. The convenience command without the
`backend` argument runs all the same checks independently of Actions.

## Measured verification evidence

Frozen diagnostic checkpoints are distinct from later focused additions:

| Checkpoint                                           | Behavioral tests          | Native lines    | Native branches |
| ---------------------------------------------------- | ------------------------- | --------------- | --------------- |
| Accepted-base backend, default emitted-code producer | 323 passing / 55 suites   | 4,542 / 8,040   | 3,405 / 6,662   |
| Source-first backend unit checkpoint                 | 718 passing / 66 suites   | 5,877 / 7,115   | 4,757 / 6,150   |
| Combined source-first backend checkpoint             | 1,083 passing / 78 suites | 6,503 / 7,115   | 5,249 / 6,150   |
| Executed disposable-database backend recipe          | 1,513 passing / 83 suites | 6,871 / 7,115   | 5,586 / 6,150   |
| Complete frontend legacy V8 checkpoint               | 509 passing / 67 files    | 13,742 / 34,409 | 3,217 / 4,079   |
| Frontend source-aware native V8                      | 589 passing / 69 files    | 4,970 / 11,742  | 4,259 / 10,687  |

Both exact-coverage commands failed honestly. The frozen released shared checker
accepted both complete native inventories and rejected the actual gaps: 244
uncovered backend lines and 564 branches, plus 6,772 uncovered frontend lines
and 6,428 branches. Later focused tests are not included
in these counters until a new complete native report is measured. An Istanbul
frontend comparison was also retained, but its incomplete source inventory was
not adopted.

Frontend type generation, TypeScript and production build passed after repairing
16 existing type-contract diagnostics. Meaningful tests also demonstrated a
malformed local-test session expiry defect: `Date.parse` could return `NaN` and
reuse an invalid cached token. The narrowly scoped finite-expiry repair has
failing-before and passing-after evidence. Further tests cover actual Program
and Control route rendering, scene/transition and event reconciliation, audio,
session lifecycle, editor controls, and backend lifecycle/transaction boundaries.
Two previously undiscovered Node-test files now run their existing assertions
through the supported frontend runner.

All eight backend e2e suites passed, **34 tests**, against isolated local
PostgreSQL 17 after every migration. Tests boot the actual compiled Fastify entry
point under stock Node 22, exercise normal local-session issuance and real global
authorization, and make protected PostgreSQL reads. Destination tests own their
fictional catalog/program data and local Alana fixture, including cleanup.
Native CLI tests additionally verify bounded stdin, redacted preflight failures,
private export/no-overwrite behavior and real PostgreSQL report/apply/idempotency
while preserving the original subject. No live identity migration is performed.
The actual authenticated Prometheus scrape passed `promtool check metrics`
from `prom/prometheus:v3.9.0`, image digest
`sha256:3ea2ed3b8cdfe3ff78aa05473a7ad36b916bdf2464c83b06bcd37c1a67620233`.
Failed reviews, original fixture failures and alternate-producer diagnostics are
retained outside source control. No test is skipped to manufacture acceptance.

## Unreachable declaration cleanup

A repository-wide TypeScript compiler-symbol audit found seven private declarations
with no callers, JSX bindings, exports, returned references, property assignments
or dynamic uses. Control's `openSceneModal`, `openEditSceneModal`, `createScene`
and `deleteScene` were detached from the rendered interface. ManualRundown's
`loadSequences` and `loadScenes` callbacks were never called, and `deepMerge`
referenced only itself. Their initializer expressions created deferred closures;
the two `useCallback` dependency arrays read only the existing program identifier.
No documentation/configuration promised these private identifiers as an interface.

Only those seven complete declarations were removed: 113 lines from Control and
40 from ManualRundown. No application file, reachable fallback, validation guard,
source inventory entry or coverage counter was excluded. Existing UI behavior is
verified through the unchanged runtime tests for real Control and ManualRundown
workflows. The source before removal remains available at
`12cb3d42695ef071592a294ae1811a3c542fb9d9`; full symbol references, exact source
hashes, original bytes and deleted declaration ranges are retained with the task's
external diagnostics. This cleanup is a separate change from installing the
native producer. The frozen frontend coverage rows predate this removal and do not
silently claim new totals.

## Validated runtime boundaries

Independent static review identified a few unreachable alternatives without
changing product behavior. Template network classification now relies on its
sole caller's native IPv4 validation while retaining every reserved-range rule.
The redirect loop expresses its existing return/throw structure and retains the
same maximum four requests, per-hop destination checks and failure messages.
Realtime upgrade rejection accepts only its actual private-call codes, 400/401,
with the same HTTP responses. Its unchanged UTF-8 decoder is a named pure helper;
tests exercise real string, Buffer, fragmented multibyte Buffer and ArrayBuffer
forms without changing websocket internals or invoking private handlers.

Playback helpers now receive the same already-owned state object from validated
callers. The private state map never removes or replaces an entry; callbacks read
current fields from that object. Public unknown-program, active-song, request,
queue, frozen-state, generation and asynchronous ownership guards remain.
Autoplay's known positive-duration cycle and unknown-duration traversal encode
established invariants. The sparse-array guard and known-duration numeric-overflow
fallback remain and have real public-input counterexamples in the tests. No
native predicate, private map, callback extraction or counter alteration is used
to manufacture coverage.

These changes are separate from repairing a product defect. Existing fractional
fader behavior and other external product diagnostics are unchanged. Negative
controls, public concurrency/error regressions, source hashes and exact before
bytes are retained outside the repository. The canonical backend verifier rebuilt
both production and instrumented application trees and passed all 1,991 native
cases and all 34 normal e2e cases after these refactors; coverage still failed.
Later test-only additions are measured separately at the frozen checkpoint.

## Protected installation and hosted proof still required

The accepted base has no local recipe, trusted Clouseau policy, or enrolled
signing identity. Initial trust installation remains separate from ordinary PR
approval and must use the shared supported bootstrap. The released engine
includes owner-only automatic merge, convergence and completeness manifests;
their hosted path is not yet installed or proved in this repository. The audited
release documented fixed reviewed engine pins. Any automatic protected-main
engine integration must use the current released shared resolver, rather than a
competing consumer updater; that hosted integration remains unproved here.

The original accepted-base audit found no CODEOWNERS, branch protection or
rulesets. GitHub identifies `gaulatti` as the sole collaborator/administrator;
accepted history identifies the same maintainer. Proposed `.github/CODEOWNERS`
therefore assigns all paths and itself to `@gaulatti`, replacing no existing
ownership boundary. Proposed ownership cannot authorize its own change.

The live policy follow-up confirms auto-merge is disabled and active main-branch
ruleset `25801209` requires PRs, prevents deletion and force pushes, dismisses
stale reviews on new pushes, and requires resolved review threads. It has no
bypass actors. These are temporary guardrails: the required approval count is
zero and required Clouseau/verification checks are not installed. This is not
fully verified protection or acceptance enforcement. Actions approving reviews
remain disabled, and no Clouseau CI provider secret is installed.

The intended policy permits applicable internal code-owner-authored PRs to merge
automatically only after the complete suite, exact 100% line and branch coverage,
and required Clouseau gates pass. The author must own every affected path from
the exact accepted protected base, including both sides of renames. Missing or
unverifiable ownership denies automatic merge. External or non-owner
contributions require current-head human code-owner approval and manual merge;
repository visibility alone does not require manual merge. Initial bootstrap
owner acceptance is a separate trust operation. Live auto-merge remains disabled
until supported enforcement is installed and verified.

Remaining coverage work is tracked in
[backend issue #82](https://github.com/gaulatti/alcantara/issues/82) and
[frontend issue #83](https://github.com/gaulatti/alcantara/issues/83). The frozen
verification and capacity evidence at
`9d12ef5b13d9757549e265995130a40d58718ed3` is historical; this policy-only
follow-up does not claim a new coverage result. Required verification/acceptance
checks and fresh approval enforcement remain to be installed without removing
unrelated controls, adding bypasses, or waiving coverage. No ready
installation/proof PR, receipt reuse, paid fallback review, bot approval,
protected merge, or successful unattended proof is claimed.

## Deployment and documentation

Backend and frontend push-to-main workflows perform real production AWS/SSM/S3
operations for their path filters. Application-path installation changes require
deployment authorization before opening an automatically deployable PR. No
production operation was run for this task.

The last observed successful deployments both used
`43190938039d975f83751efddde20fc1e23456b0`:
[backend run 38093068080](https://github.com/gaulatti/alcantara/actions/runs/38093068080)
and [frontend run 38093068071](https://github.com/gaulatti/alcantara/actions/runs/38093068071).
Those historical runs do not prove deployment of this candidate or current live
health. No deployment-bound documentation publisher is installed. GitHub has the
public wiki feature enabled, but the startup updater could not access its wiki
remote; documentation is maintained here until a real supported publication
route is available. Documentation publication and ticket closeout remain unproved.
