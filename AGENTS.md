# naia-pj-adk

Private, team-and-project-centered ADK. The project, not an individual agent, is the unit of context and authority.

## Mandatory reads

Before acting, read:

1. `.agents/context/project-policy.yaml`
2. `.agents/context/workflow.yaml`
3. `.agents/context/development-method.yaml` before scoping or building anything
4. `.agents/context/execution.yaml` before any build, deployment, or verification
5. `.agents/context/discord.yaml` when Discord is involved
6. `projects/<project>/project.yaml` and its `AGENTS.md` before project work
7. `docs/WORKSPACE.ko.md` for directory layout
8. `data-branch/<current-git-branch>/AGENTS.md` when that file exists. `/` in the branch name is a directory. `AGENTS.md` and `CLAUDE.md` in the same folder must be identical. If missing, read `data-branch/_template/` only.

## Non-negotiable rules

- Every work item starts from a GitHub issue. The issue is the durable source of truth for scope, decisions, validation, merge, deployment, and rollback.
- Code work happens in each participant's SSH workspace using an issue branch. Codex and Claude inherit the same repository rules.
- Never infer merge, deployment, database, secret, or production authority from a Discord message or from access to a coding tool.
- Discord is a coordination surface. Use one bot token and one gateway consumer per project, and one thread per GitHub issue.
- A direct message selects the sender's registered workspace but grants no additional authority.
- Never store tokens, passwords, personal Discord IDs, private hostnames, IP addresses, customer data, or production topology in tracked files. Use ignored runtime configuration and placeholders.
- Do not copy requirements, progress records, logs, examples, or Git history from another project unless each item is intentionally adopted and safe for this repository.
- Public creation, visibility change, template publication, or public push fails closed until the full tree and reachable Git history pass public-safety review and the owner approves the exact commit SHA.
- Classify the change before assigning it. A feature needs a confirmed use case and a feature spec before implementation starts; skipping that is how part of a task gets reported as all of it.
- A term that is not in the glossary is a question, not a guess.
- A deployment guard is a command that exits non-zero, not a paragraph. An adapter whose `execution` commands are still `null` is not ready for the target those commands name.
- Deployment is incomplete until the new revision is proven to be serving. Writing files, reloading a process, and taking effect are three different events.
- A pass means the asserted body content appeared twice in a row and the checking process exited zero. A status code alone is not a pass.
- Rollback must already exist as an artifact before the change begins.
- Do not stall a thread to ask permission for a production read that cannot take the service down with traffic, or for a user-visible incident deploy whose system risk is not high. Judgment lives in `execution.yaml` `ops_profile`. High-traffic reads, irreversible change, and human-only decisions still need approval.
- Do not dump bot work on the professional developer or deployer. Owed bot replies are dispatched as jobs. Re-asks go to the last human in the thread. Owner DMs are for watchdog failure and timed owner approval only.
- Re-asks go only inside `discord.contact_window`. Deferred asks do not spend the re-ask budget. An urgent flag does not open that window. Classify a notice before sending: silent, window, or immediate. Immediate is only a persisted user-visible outage, a dead gateway websocket, or a failed delivery of a real send. A probe, canary, one-sample slowness, its recovery, or bot silence is not a watchdog malfunction and must not bypass the window. Fail-then-pass under the streak threshold sends nothing. Do not post those to the home channel, and do not reply to them. Ledger every outbound send with process, destination, kind, and result.

## Project boundary

Generic contracts live in `.agents/context/`, reusable project scaffolding in `projects/_template/`, and project-specific facts only in `projects/<project>/`. Product git clones live in gitignored `checkouts/`, never next to adapters. Branch-specific agent context lives in `data-branch/`. Execution evidence belongs in GitHub issues; `.agents/progress/` contains only sanitized local review artifacts.

`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` are byte-identical. Change one, change the others. `CODEX.md` is a short pointer only.

## Completion

Do not claim completion without the issue-linked acceptance evidence required by the project policy. Deployment completion requires environment, commit SHA, operator, validation, and rollback reference in the issue.
