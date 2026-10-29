# Alcantara review contract

Alcantara is a TV and radio broadcast control system. A NestJS/Fastify/Prisma
backend (PostgreSQL) owns programs, scenes, layouts, flights, the song and
instant library, radio automation driven by authoritative Palazzo playback
telemetry, LiveKit WebRTC contribution, managed external sources, versioned
broadcast-destination selection (Alcantara to Alana to Croccante) and program
recording. A React Router frontend operates it, and a small CDK package
(`infra/aws`) describes its AWS deployment role infrastructure.

Preserve program isolation, the authentication and authorization boundary,
durable idempotency before audible or public effects, bounded dependency
retries, bounded metric labels (controlled enums and normalized routes only),
and the guarantee that stream keys, signed URLs, tokens, secret payloads and
article or customer content never reach logs, metrics or responses. Command
acceptance is not proof of playout; authoritative engine observations are.
Publication and recording state are security boundaries: only an explicitly
publishable state may produce a live effect, and non-publishable states fail
closed.

Assess purpose and evidence rather than the number of changed files or lines.
Bug fixes, meaningful tests that raise coverage, dependency repairs and
operational maintenance can serve this existing system without a new product
decision. New capabilities need repository documentation or linked acceptance
criteria that establish their need and boundaries. Production deployment is a
separate, explicitly authorized operation: merging to `main` runs the existing
deploy workflows, and a merge is not a deployment, health or on-air claim.

Ask gaulatti for a second opinion for a product-direction or authority decision:
for example a new public-destination provider, a change to who may start or stop
a broadcast, a new externally exposed control surface, multi-tenant hosting, or a
change to what is retained from a recording. Ordinary implementation uncertainty
and repairable bugs belong to automated investigation, not routine human code
review. Changes to review controls, coverage scope or exclusions, or this
purpose contract require explicit owner confirmation.

Every material capability and mechanism must independently score at least 80 for
fit, need and proportionality under Clouseau's shared protocol. A causal technical
finding at or above 70 blocks; unrelated features or good scores cannot average
away a defect. Integrity and review-completeness gates remain independent.

Tests must assert actual production behavior and failure outcomes. Reject
fabricated coverage, disabled tests, swallowed errors, unconditional assertions
and mocks that replace the behavior being claimed. Fault injection at an
external boundary (database, network, filesystem, LiveKit, AWS) is legitimate when
the real application contract and failure handling remain exercised. The gate
requires exactly 100% line and branch coverage of the application TypeScript and
JavaScript under `backend/src` for every contribution, including external forks,
and unloaded modules are measured. The React frontend (`frontend/`), the CDK package
(`infra/aws`) and `backend/scripts` are outside the exact-coverage gate for now;
their own tests still run where they exist. Narrowing or widening the gate is a
review-control change that requires owner confirmation.

A passing local Clouseau review may be reused only through a signed receipt from
an enrolled trusted workstation and the matching native GitHub author. CI must
independently verify current protected policy, exact head/base and engine content,
expiry, evidence and deterministic scores. All native tests, exact coverage and
branch protections remain mandatory. Clouseau owns the shared scoring,
investigation, repair bounds, evidence ledger, native approval and auto-merge;
this repository owns its purpose and real tests.
