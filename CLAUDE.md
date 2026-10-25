# Alcantara agent instructions

Read and follow `AGENTS.md`, including the managed startup updater. Read the
accepted requirement, `README.md`, and `.github/clouseau.md` before implementation.

Verify the complete committed candidate with real tests, type checks, builds,
runtime checks, and native coverage. Record actual verification and coverage
outcomes separately from the local AI quality decision. Independent CI technical
acceptance and automatic approval/merge still require all mandatory tests and
exact 100% application line and branch coverage.

Before opening every PR, run shared Clouseau local AI review through an
authenticated supported Codex or Claude Code harness regardless of partial
coverage, a failing coverage command, or unavailable/invalid coverage. Report
those conditions honestly; they never suppress local AI review or become
invented passing counts. Investigate its findings,
repair demonstrated blockers within the accepted requirement, and review the
final changed revision. Preserve negative evidence. Publish eligible signed
evidence with `clouseau publish` and put the returned receipt marker in the
initial PR body. A local AI quality receipt does not authorize technical
acceptance or merge. Never fabricate a receipt or treat proposed policy as trusted
base policy. Keep local installation independent of CI keys and configuration.

Initial installation is currently blocked as recorded in
`docs/clouseau-integration.md`. Preserve concrete work and verification evidence
when source completeness, accepted trust or shared evidence capacity blocks
review. Use the released initial-installation procedure where required; do not
bypass checks or claim a review that did not complete. Human decisions concern
purpose, authority,
ownership, credentials, or meaningful product/risk tradeoffs. Investigate and
repair technical defects using automated evidence.
