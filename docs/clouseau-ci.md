# Clouseau CI

Pull requests are verified and reviewed by the public
[Clouseau](https://github.com/gaulatti/clouseau) engine through
`.github/workflows/ci.yml`. Review contract: `.github/clouseau.md`;
configuration: `.github/clouseau.json`; local agent recipe:
`.clouseau-local.json`.

## What the `verify` job runs

On every pull request (no path filter), against a disposable PostgreSQL 17
container:

- Clouseau's own approval-policy tests and this repository's workflow routing
  tests (`.github/tests`);
- Prisma client generation and committed migrations;
- the backend unit suite with native V8 coverage
  (`pnpm --dir backend run test:coverage`) and the exact-100% gate over
  `backend/src` (Istanbul report `backend/coverage/coverage-final.json`);
- the end-to-end metrics and media-label concurrency suites, with the produced
  scrape parsed by `promtool check metrics`;
- the backend deployment contract tests (`test:deployment`);
- the backend build and the `infra/aws` tests and build.

This replaces the former path-filtered `Backend CI` workflow, which did not run
for changes outside its paths and could not be a required check.

## Coverage scope (deliberate, documented exclusion)

The exact gate covers every non-test TypeScript and JavaScript file under
`backend/src`. Not gated for now: the React frontend (`frontend/`, about 42k
lines, Vitest/jsdom, no coverage provider installed), `infra/aws` (CDK, Jest
assertions) and `backend/scripts` (Node test runner). Their tests still run
where they exist. Changing this scope needs owner confirmation.

## Local review

`.clouseau-local.json` runs the backend build and coverage suite, then checks
`backend/src` for exact coverage. See `AGENTS.md` for the required pre-PR review.

## Operator setup

Repository secrets used by the workflow: `DEEPSEEK_API_KEY` and
`TYPESAFE_API_KEY` (CI AI review) and `DEPLOYMENT_TOKEN` (the bounded repair
author). The Clouseau workflow never deploys. Merging to `main` still triggers
the existing `Backend Deploy` and `Frontend Deploy` workflows, which are
unchanged. Protected central Clouseau `main` is resolved at the start of each run
and frozen for it; there is no static engine pin to update.

Repository settings (not changed by the install PR): enable auto-merge and
replace the `Clouseau installation guardrails` ruleset with one that requires the
`verify` and `approve-and-merge` checks and one approving review; the ruleset
JSON is in the install PR description.
