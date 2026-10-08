# naia-video-avatar project adapter, local profile

This adapter points to the product repository `nextain/naia-video-avatar`.
The target repository is an independent product repository adopting the standard development process and artifact contracts of naia-pj-adk; it is not a fork or a template copy.

Artifact locations follow the `artifacts` section in `project.yaml` and the mapping table in the product repository's `docs/planning/README.md`.
Existing product identifiers map to standard artifacts as follows:
- UC maps to UC
- REQ and NFR map to RQ
- SPEC maps to FE
- TEST-F maps to UT
- TEST-S maps to E2E

Product source clones must stay outside `projects/` (such as in sibling directories or separate checkouts) and are never nested under this adapter.
The adapter's `team_policy` is the source for issue authority, working hours, approval gates, and assignment routing.
