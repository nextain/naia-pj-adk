**English** | [한국어](README.ko.md)

# naia-pj-adk

A public ADK that helps teams using several development tools and workspaces
work under one set of project rules. This repository is not product source; it
provides project adapters, verifiable work procedures, and gateway operation
components.

The core principles are:

- GitHub issues are the source of truth for work. An issue records the assignee, acceptance criteria, verification, and rollback.
- Development happens on issue branches. Merge and deployment rights are decided by project roles.
- `team_policy` in `projects/<project>/project.yaml` declares issue permissions, work hours, approvals,
  and who owns unanswered threads.
- Discord handles issue threads and work hand-off. Conversations and tool access do not
  create operational authority.
- Tokens, passwords, personal IDs, private hosts, customer data, and operational state are not tracked.
  Runtime registries live in ignored files.
- Product source clones live outside `projects/`. Where they go is decided by the deployment profile.
- Messaging is provided by the `naia-messaging` package; each instance has a pinned version and configuration plus the host's work and permission adapters. The common engine is not duplicated.

## Deployment profiles

What a team needs depends on whether it shares one server or each member clones
and works on their own machine. This repository separates that difference into two
`profiles/<name>/` directories. They are directories rather than branches because,
with branches, a fix to the common contract lands on only one side and the two
drift further apart over time.

`server` is a team deployed alone on a single server. Each participant has their
own home on it, and the deployment layer is the place where one person's mistake
affects everyone. The deploy gate, artifacts and promotion, rollback, leases,
drift, and environment layers are this profile's contract.

`local` is a team where each member clones the product repository onto their own
machine. There is no shared host and no deployment layer, so the place where work
is handed over lives in the repository. Assignment, receipt, start, and result are
all commits. The device registry, round queue, sibling workspace checks, and
handoff records are this profile's modules.

The contract both profiles keep stays in `.agents/context/`. How people are
prompted for answers, the format of confirmation requests, the definition of
receipt acknowledgement, and the rule that AI does not declare completion are the
same wherever it is deployed.

An adapter declares one `profile` in `project.yaml`, and the validator applies only
that profile's requirements. If fields from one profile remain in the other, it is
rejected. See [deployment profiles](profiles/README.ko.md) (Korean) for details.

Only adapters that declare `policy_contract_version: 1` are connected to the common policy guard. The
`contributors`, `integrators`, and `release_owners` entries in `roles` are role groups, and one person may
belong to several groups. Only the roles or groups listed in `team_policy.authorization.issue_work_roles`
can be delegated issue work; the name `contributors` alone does not grant write access. Existing
adapters must be migrated explicitly by their owner, filling in roles, groups, and issue work permissions.
The participant registry is an untracked runtime projection, and `ops/gateway/dcg.sh` maps a registered
sender ID to an alias, workspace, and role, then checks issue assignment, work hours, approvals, and
operational commands. The host's Discord/GitHub authentication and file permissions are provided by a
trusted-host boundary outside this repository.

## Starting a new project

Choose a deployment profile first. For server, copy `projects/_template/`; for local,
copy `projects/_template-local/`. Fill in the project facts and roles, then set
`team_policy.work_hours`, which allows changes, and `discord.contact_window`, during
which people can be contacted. The two windows may differ. Turn on Discord only after
the runtime registry and tokens are ready; a new adapter first validates its contract
while inactive.

The branching model follows the `integration_branch` declared by the adapter.

- main-only: set both `default_branch` and `integration_branch` to `main`, create issue
  branches from `main`, and merge them into `main`.
- Declared integration branch: declare the actual integration branch name in the adapter,
  and create and integrate issue branches there. Production promotion is done separately
  with the exact approved revision.

For detailed procedures for new contributions, failure recovery, and rollback, see the
[team development operating procedure](docs/WORKFLOW.ko.md) (Korean); for directory
rules, see the [workspace layout](docs/WORKSPACE.ko.md) (Korean).
The development procedure from planning to testing and review is in `docs/pipeline/`.

## First contribution from an independent clone

```bash
git clone <public-repository-url> <project-directory>
cd <project-directory>
git fetch origin --prune
```

Fork the canonical repository, then set `origin` in the clone above to your fork and
`upstream` to the canonical repository's HTTPS URL. Create an issue branch from the
adapter's `integration_branch`, then run the verification commands linked to the issue.
Keep the standard output, standard error, and exit code of the results, and describe the
change scope together with verification and rollback steps in the PR. Contributors do not
perform production deployments or database changes.

Choose a small, reversible change for your first mission, such as a single document file
or one contract test case. Prerequisites are a GitHub account and fork, Node.js 20 or
later, an open issue with an assignee, acceptance criteria, an issue branch, and an
executable rollback plan. Passing PR CI does not mean the reviewer's independent review,
the integrator's merge, or the release owner's production approval is done.

For high-risk changes, a reviewer independent of the implementer checks the exact diff,
the commands run and their results, the scope of impact, concurrent changes, and the
rollback artifacts. This repository's production workflow does not run on push or PR; it
is a fail-safe guard that requires `workflow_dispatch` and an explicit `production`
environment. With the inactive example adapter there is no deploy command, so it stops
with exit code 1.

The gateway's issue-work connects only through `submit`, `restart --job <id>`, and `amend`;
`retry` is not a native runtime command. Issue work must name an authenticated project
backend and does not bypass it through a native personal runtime. Native `service` and
`cutover prepare|verify|canary|rollback` are treated only as runtime management, not as
production deployment. production, database, and rollback use only the backend commands
declared in the adapter's `gateway.project_backend.capabilities`, and pass exactly one
approved `--revision <40-character SHA>` in the command arguments. If `POLICY_REVISION`
is also used, it is checked to be the same value. Only `artifacts list` is allowed as a
native query; `artifacts prune` is a mutating command and the gateway rejects it.
`attachment --output` runs only as a restricted download that explicitly sets
`PROJECT_POLICY_OPERATION=attachment-download`. `contact-window` checks contact hours
without calling the backend.

`service`, `cutover`, and `cancel` are local operations recovered on the runtime owner's host.
They are not forwarded automatically to a project backend or remote router, and a remote
request must pass separate authenticated owner authority.

`PROJECT_GATEWAY_WORKSPACE` is the canonical absolute workspace path that the trusted host
projects from the authenticated participant. It is passed to the project backend only when it
is an existing directory matching the participant's workspace in the registry. issue-work and
high-impact project backends run in this canonical path. This value check does not replace a
host filesystem sandbox.

## Gateway capabilities and collaboration boundaries

A project adapter's `gateway.project_backend.capabilities` declares command names and argument
shapes. The bridge takes the adapter, the authenticated participant and role, evidence of an
open issue, the route's project ID, and the canonical workspace as input, re-checks policy, and
returns the exact `argv`, `cwd`, and allowed paths, or a rejection reason. The caller that
receives this result does not append arguments or switch to a different workspace on its own.
issue-work's repository, number, and assignee and restart's job id are projected only into the
declared placeholder positions, and production, database, and rollback pass the approved
40-character SHA once via `--revision`.

Role changes and workspace links are applied only while the participant registry's mutation
window is open. When the window is closed, only reads and diagnostics remain, and the existing
registry is not silently overwritten. Older adapters first create and validate a migration diff
that states `policy_contract_version`, `issue_work_roles`, work hours, and capabilities
explicitly. Old field names and nearby `tmp` files are not used as automatic recovery input.

Division of work is fixed together with permissions. A contributor proposes issue work and
verification, an integrator integrates after independent review, and a release owner handles
production, database, and rollback approval and the production revision. A reviewer checks the
diff, logs, and rollback evidence separately from the implementer, and a remote router only
forwards authenticated requests; it does not take over local runtime ownership.

## Verification

```bash
npm test
```

`npm test` runs contract, structure, gateway self-test, and public-safety checks in order.
The public-safety check covers both the current tree and reachable Git history. Making the
repository public, publishing templates, and pushing are done separately after the owner
reviews the exact candidate SHA.

This repository ships the common example adapter in an inactive state, so passing the example
checks does not prove an actual project deployment. Product-specific deploy commands and runtime
credentials are supplied by each project through its own adapter and ignored runtime configuration.

## License and third-party material

The original material in this repository is distributed under Apache-2.0. Following `NOTICE`,
the original notices and licenses of third-party source and trademarks added downstream are
preserved. Rights to names or material are not transferred by this repository's license.

The scope adopted across repositories and the personal and operational material that was excluded
are described in the [lineage document](docs/LINEAGE.ko.md) (Korean), and the detailed fork, PR,
failure, and rollback procedures are in the
[team development operating procedure](docs/WORKFLOW.ko.md) (Korean).
