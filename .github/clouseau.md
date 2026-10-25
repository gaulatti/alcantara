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
coverage are required for independent CI technical acceptance and automatic
approval/merge. Local AI quality review is required before every PR regardless
of partial coverage, a failing coverage command or unavailable/invalid coverage.
Record the real verification and coverage outcomes separately from the AI
decision; never suppress AI review or invent passing coverage because of them.
Uncovered application files must remain in the native
reports. Test code is separate from application coverage; unrelated dependencies
and generated output cannot mask application gaps.

Review-control and signing-enrollment changes require the supported explicit
owner installation procedure. Ordinary contributions require independent CI
verification and either eligible signed local evidence or the configured
qualified CI provider. Invalid evidence must fail closed without paid fallback.
An unsigned report is diagnostic evidence, never an approval receipt. A signed
local AI quality receipt authenticates reusable review evidence; it cannot waive
independent CI tests or exact coverage or authorize merge on its own. Missing
accepted trust, incomplete immutable source and shared evidence-capacity limits
remain genuine review blockers.

Applicable code-owner-authored PRs may merge automatically after the complete
mandatory test suite, exact 100% line and branch coverage, and all required
Clouseau review gates pass. The released shared controller must establish that
the actual PR author owns every affected path from the exact accepted protected
base, including both paths of a rename. Missing ownership or unverifiable
membership grants no automatic merge. General write access is insufficient, and
a proposed CODEOWNERS edit cannot authorize its own author. Repository visibility
does not impose a blanket manual-merge policy on eligible owner contributions.

External or non-owner contributions require current-head human code-owner
approval and manual merge. Automated approval alone cannot authorize their
merge. Initial trust installation remains separate from ordinary PR approval
and follows the released bootstrap's owner-acceptance procedure. Consume shared
merge enforcement; do not implement a consumer merge controller.

Production AWS, SSM, CDK, CloudFormation, migrations, and infrastructure operations
require separate explicit authorization. Existing push-to-main deployment
workflows are production operations; never use them to demonstrate installation.
Documentation must describe the actual deployed revision. Missing wiki availability
or deployment-bound documentation support must be reported honestly.
