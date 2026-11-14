# Backend verification

Use Node 22, pnpm 9 and a local Docker context, then run from the repository root:

```sh
pnpm install --frozen-lockfile
node backend/scripts/verify-local.mjs
```

The runner creates an isolated temporary PostgreSQL 17/pgvector database (the same `pgvector/pgvector:pg17` image as Compose), applies the real
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

The reconciled verifier uses the actual split CLI entry points (`runtime-secret-contract-cli.js` and `principals-cli.main.js`), not import-only libraries. Upload tests follow the landed 200 MiB audio boundary and still reject one byte above the limit before storage. Native coverage gaps and failed migrations remain failures.

Remaining source reconciliation expresses closed invariants rather than testing impossible states. The private test-auth permission visitor receives only the fixed nested string tree; both catalog-normalization callers supply a required destination id; every final Palazzo retry returns or throws; and engine callbacks retain the state from their initiating operation (the map has no delete/clear operation). Passing that captured state makes the lifetime requirement explicit. A leaf resolved synchronously from a sequence belongs to the same tree being advanced. Existing public refusal, failure, retry and queue-order tests remain required.

Recording boundary coverage exercises bounded ticket eviction, upstream header timeout/cancellation, absent/rejected download bodies, range-unsatisfiable propagation, tape transport/format failures and bounded error metadata. Sequence-catalog export now uses the actual object-shaped sequence and requires exactly the unique catalog ids, omitting leaves without an id; the old array fixture had only asserted that an array existed.
