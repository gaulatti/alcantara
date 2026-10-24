# Alcantara purpose and change acceptance

Alcantara is a broadcast control plane for television overlays, radio playout,
and simulcast. It owns operator workflows, reusable layouts/scenes, program
state and SSE projection, media identity, and authorization through Pompeii.
Alana owns captured output publication and composed recording; Palazzo owns
radio playback; external registered renderers own their presentation assets.
The contracts in `README.md` and `docs/` establish those boundaries.

The consumer owns its real verification commands, complete application-source
inventory, code ownership, and deployment contract. Shared Clouseau owns review
rules, scoring, provider qualification, receipt validation, and merge decisions.
Consume its released implementation without copying that engine into Alcantara.

Application verification covers both `backend/src` and `frontend/app`, plus
the applicable deployment, migration, integration, infrastructure-definition,
and runtime checks. All tests and exact 100% application line and branch
coverage are required. Uncovered application files must remain in the native
reports. Test code is separate from application coverage; unrelated dependencies
and generated output cannot mask application gaps.

Review-control and signing-enrollment changes require the supported explicit
owner installation procedure. Ordinary contributions require independent CI
verification and either eligible signed local evidence or the configured
qualified CI provider. Invalid evidence must fail closed without paid fallback.
An unsigned report is diagnostic evidence, never an approval receipt.

Automatic merge may operate only when the released shared controller establishes
that the actual PR author owns every affected path using accepted protected-base
ownership. General write access is insufficient. Non-owner contributions require
current-head code-owner involvement and manual merge. Do not invent a consumer
merge controller while the shared implementation is unavailable.

Production AWS, SSM, CDK, CloudFormation, migrations, and infrastructure operations
require separate explicit authorization. Existing push-to-main deployment
workflows are production operations; never use them to demonstrate installation.
Documentation must describe the actual deployed revision. Missing wiki availability
or deployment-bound documentation support must be reported honestly.
