# naia.land project adapter

Read the repository root `AGENTS.md`, then `project.yaml` and
`docs/OPERATIONS.md` in this directory.

- The GitHub issue is the source of truth for every change.
- Work only in the registered Naia SSH workspace on an `issue/<number>-*`
  branch.
- Discord coordinates work; it never grants merge, deployment, database, or
  secret authority.
- Keep Discord snowflakes, participant mappings, tokens, private topology, and
  concrete deployment commands in the ignored `.runtime/naia-land.json`.
- Development deployment is allowed only through `scripts/project-ops.mjs`.
- Production deployment and database writes are out of scope and fail closed.
- Never reuse Cafelua, OnMam, or AIPOL runtime configuration for this adapter.

