# Project adapter

Read the repository root `AGENTS.md`, then `docs/WORKSPACE.ko.md`, then `project.yaml` here.
Product source clones belong in `checkouts/`, not in this adapter directory.

- Replace every placeholder before activating this adapter.
- Keep secrets and participant IDs in the ignored `.runtime/` registry.
- Keep `team_policy` and the declared integration tier aligned with the
  Discord contact window and branch mode.
- Record all work, validation, integration-tier deployment, acceptance, and
  production deployment in the GitHub issue.
- Use a fork and HTTPS pull request for contribution. The public example stays
  disabled until its placeholders are replaced and its production guard is
  implemented by the project owner.
- Project commands do not grant authority; the role mapping and issue approval do.
