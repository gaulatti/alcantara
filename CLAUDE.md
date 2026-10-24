# Alcantara agent instructions

Read and follow `AGENTS.md`, including the managed startup updater. Read the
accepted requirement, `README.md`, and `.github/clouseau.md` before implementation.

Verify the complete committed candidate with real tests, type checks, builds,
runtime checks, and native coverage. Clouseau acceptance requires exact 100%
application line and branch coverage.

Before opening a ready PR, run the shared Clouseau skill locally through an
authenticated supported Codex or Claude Code harness. Investigate its findings,
repair demonstrated blockers within the accepted requirement, and review the
final changed revision. Preserve negative evidence. Publish eligible signed
evidence with `clouseau publish` and put the returned receipt marker in the
initial PR body. Never fabricate a receipt or treat proposed policy as trusted
base policy. Keep local installation independent of CI keys and configuration.

Initial installation is currently blocked as recorded in
`docs/clouseau-integration.md`. Preserve concrete work and verification evidence
when a supported shared bootstrap is unavailable; do not bypass checks or open
a PR claiming review acceptance. Human decisions concern purpose, authority,
ownership, credentials, or meaningful product/risk tradeoffs. Investigate and
repair technical defects using automated evidence.
