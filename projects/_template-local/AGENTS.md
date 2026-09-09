# Project adapter, local profile

Read the repository root `AGENTS.md`, then `docs/WORKSPACE.ko.md`, then
`profiles/local/README.ko.md`, then `project.yaml` here.

- Replace every placeholder before activating this adapter.
- This profile has no shared host. There is no `workspace.ssh_home_pattern`, no
  `tiers` and no deploy command; a copy that still carries one names a path or a
  target nobody has.
- Register every device that runs work in the directory named by
  `local_workspace.devices_dir`. A claim by an unregistered device names an
  executor nobody can find.
- Product source clones are siblings of this repository at `../<id>`, listed in
  the workspace catalog. They are never nested under this adapter.
- Keep participant identities in the ignored `.runtime/` registry.
- Record all work, validation and acceptance in the GitHub issue. Posting is not
  receiving and receiving is not starting; only a start receipt is a start.
