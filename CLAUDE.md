# naia-pj-adk

Private, team-and-project-centered ADK. The project, not an individual agent, is the unit of context and authority.

## Mandatory reads

Before acting, read:

1. `.agents/context/project-policy.yaml`
2. `.agents/context/workflow.yaml`
3. `.agents/context/discord.yaml` when Discord is involved
4. `projects/<project>/project.yaml` and its `AGENTS.md` before project work

## Non-negotiable rules

- Every work item starts from a GitHub issue. The issue is the durable source of truth for scope, decisions, validation, merge, deployment, and rollback.
- Code work happens in each participant's SSH workspace using an issue branch. Codex and Claude inherit the same repository rules.
- Never infer merge, deployment, database, secret, or production authority from a Discord message or from access to a coding tool.
- Discord is a coordination surface. Use one bot token and one gateway consumer per project, and one thread per GitHub issue.
- A direct message selects the sender's registered workspace but grants no additional authority.
- Never store tokens, passwords, personal Discord IDs, private hostnames, IP addresses, customer data, or production topology in tracked files. Use ignored runtime configuration and placeholders.
- Do not copy requirements, progress records, logs, examples, or Git history from another project unless each item is intentionally adopted and safe for this repository.
- Public creation, visibility change, template publication, or public push fails closed until the full tree and reachable Git history pass public-safety review and the owner approves the exact commit SHA.

## Project boundary

Generic contracts live in `.agents/context/`, reusable project scaffolding in `projects/_template/`, and project-specific facts only in `projects/<project>/`. Execution evidence belongs in GitHub issues; `.agents/progress/` contains only sanitized local review artifacts.

## Completion

Do not claim completion without the issue-linked acceptance evidence required by the project policy. Deployment completion requires environment, commit SHA, operator, validation, and rollback reference in the issue.
