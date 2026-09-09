# Example project adapter, local profile

This is a public, disabled example used by the contract tests. It shows the
shape a local-profile adapter takes: an issue branch pattern, a device registry,
a round queue and a sibling workspace, and no deployment target at all.

Copy `projects/_template-local/` rather than this file when starting a project,
replace every placeholder with project-owned values, and keep runtime identities
in ignored files.

The adapter's `team_policy` is the source for issue authority, work hours,
approval gates, and assignment routing. A chat message or tool access never
grants merge, deployment, database, or secret authority.
