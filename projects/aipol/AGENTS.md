# AIPOL project adapter

This adapter governs work from the private `aipol-lab` development plane into
the public `nextain/aipol` repository.

Before work, read the root `naia-pj-adk` mandatory context and this project's
`project.yaml`. Every code change starts from a `nextain/aipol` GitHub issue and
uses an issue branch in `/opt/aipol/workspaces/aipol`.

The existing Discord 아이폴 channel is coordination only. Use one thread per
issue. Only `workspace_owner` may write or execute; `policy_collaborator` may
read and reply. Discord does not grant merge, deployment, secret, database, or
production authority.

Development deployment is allowed only for a clean committed revision after the
gate passes, with two baseline and two post-deployment checks and a materialized
rollback revision. Production deployment is deliberately unimplemented here and
requires separate approval of an exact public commit SHA.

