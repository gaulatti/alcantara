# Clouseau integration status

This branch prepares the installation; it is not a working protected acceptance
path yet. The audited released engine is Clouseau
`c4e07381a288fc74200fd712f04ac3265ef2184a`, content digest
`1eaed29fd22aa45f111b5a8ed37da2299576e303b80743ab846ef53848c680e7`.
Its immutable cache checkout was verified clean. Use the
[released interface](https://github.com/gaulatti/clouseau/blob/c4e07381a288fc74200fd712f04ac3265ef2184a/docs/local-review.md),
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
before opening a ready PR with the returned marker in its initial body.

The audited accepted default branch was
`8a4cb2a2132810e36ca3e73ff2147ae7f5207771`. This pnpm workspace uses Node 22
and pnpm 9. Product application inventory comprises every runtime source under
`backend/src` (NestJS/Fastify/Prisma, 112 native entries including a purely typed
module) and `frontend/app` (React Router/Vite, 187 files). Colocated tests and
`.d.ts` declarations are not application code. The separate `infra/aws` package
contains deployment definitions; its existing local static tests and TypeScript
build remain verification requirements, separately from product runtime coverage.
No CDK CLI or AWS operation is part of the local recipe.

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
Clouseau parser. Neither application root can compensate for the other's gaps.
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

The combined native child-coverage path passed the complete 1,083-case backend
measurement, including every e2e suite. The new disposable-database orchestration
still needs its complete invocation verified. Neither passing tests nor a passing
producer fixture compensates for the remaining exact-coverage failures.

## Measured verification evidence

Frozen diagnostic checkpoints are distinct from later focused additions:

| Checkpoint                                           | Behavioral tests        | Native lines    | Native branches |
| ---------------------------------------------------- | ----------------------- | --------------- | --------------- |
| Accepted-base backend, default emitted-code producer | 323 passing / 55 suites | 4,542 / 8,040   | 3,405 / 6,662   |
| Source-first backend unit checkpoint                 | 718 passing / 66 suites | 5,877 / 7,115   | 4,757 / 6,150   |
| Complete frontend V8 checkpoint                      | 509 passing / 67 files  | 13,742 / 34,409 | 3,217 / 4,079   |

Both exact-coverage commands failed honestly. The frozen released shared checker
accepted both complete native inventories and rejected the actual gaps: 612
uncovered backend lines and 901 branches, plus 6,772 uncovered frontend lines
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

All seven backend e2e suites passed, **19 tests**, against isolated local
PostgreSQL 17 after every migration. Tests boot the actual compiled Fastify entry
point under stock Node 22, exercise normal local-session issuance and real global
authorization, and make protected PostgreSQL reads. Destination tests own their
fictional catalog/program data and local Alana fixture, including cleanup.
The actual authenticated Prometheus scrape passed `promtool check metrics`
from `prom/prometheus:v3.9.0`, image digest
`sha256:3ea2ed3b8cdfe3ff78aa05473a7ad36b916bdf2464c83b06bcd37c1a67620233`.
Failed reviews, original fixture failures and alternate-producer diagnostics are
retained outside source control. No test is skipped to manufacture acceptance.

## Protected installation and hosted proof still required

The accepted base has no local recipe, trusted Clouseau policy, or enrolled
signing identity. Initial trust installation remains separate from ordinary PR
approval and must use the shared supported bootstrap. The released engine
includes owner-only automatic merge, convergence and completeness manifests;
their hosted path is not yet installed or proved in this repository. The audited
release still documents fixed reviewed engine pins. Automatic protected-main
engine upgrades must use a released shared resolver, rather than a competing
consumer updater.

The effective accepted-base audit found no CODEOWNERS, branch protection or
rulesets. GitHub identifies `gaulatti` as the sole collaborator/administrator;
accepted history identifies the same maintainer. Proposed `.github/CODEOWNERS`
therefore assigns all paths and itself to `@gaulatti`, replacing no existing
ownership boundary. Proposed ownership cannot authorize its own change.

Auto-merge is enabled, but Actions approving reviews are disabled. No Clouseau
CI provider secret is installed. Required verification/acceptance checks and
fresh approval protection remain to be installed without removing unrelated
controls, adding bypasses, or waiving coverage. No ready installation/proof PR,
receipt reuse, paid fallback review, bot approval, protected merge, or successful
unattended proof is claimed.

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
