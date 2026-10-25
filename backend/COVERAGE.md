# Backend verification

Use Node 22, pnpm 9 and a local Docker context, then run from the repository root:

```sh
pnpm install --frozen-lockfile
node backend/scripts/verify-local.mjs
```

The runner creates an isolated temporary PostgreSQL 17 database, applies the real
migrations, generates Prisma, builds the backend, runs the complete unit and
end-to-end inventory with native coverage, reruns end-to-end tests against the
normal compiled application, and verifies deployment contracts and the actual
authenticated Prometheus scrape. It removes its own database on completion.
No AWS, deployment, provider credentials or Clouseau review are invoked.

`pnpm --dir backend test:cov --runInBand` requires a disposable migrated
`DATABASE_URL`. Native Istanbul instruments the authored TypeScript before the
real TypeScript compiler adds decorator metadata. The same producer instruments
child Node entry points; their native counters are merged by Istanbul. All
application source under `backend/src` is inventoried, including unimported
files. Type declarations contain no executable statements. No runtime source
is excluded. Producer regression tests protect source maps, inventories,
metadata preservation and child-process coverage.

The native JSON artifacts are `backend/coverage/coverage-final.json` and
`backend/coverage/coverage-summary.json`. Exact 100% line and branch thresholds
remain enabled. A failing threshold is reported as a failure even when every
assertion passes. Coverage gaps remain tracked in
[issue 82](https://github.com/gaulatti/alcantara/issues/82).

This backend-only work does not install trusted Clouseau policy, signed receipt
reuse or CI approval. Those require the separate integration and accepted-base
trust configuration. Partial coverage cannot produce an eligible passing review
under the current Clouseau protocol.

A push changing `backend/**` on main matches the existing backend deployment
workflow. Opening or merging a PR does not itself prove deployment or live health.
