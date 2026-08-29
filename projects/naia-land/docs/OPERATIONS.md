# Naia development operations

## Runtime setup

Copy `projects/naia-land/runtime.example.json` to the ignored path
`.runtime/naia-land.json` and replace every example value. Discord snowflakes,
participant mappings, private hosts, and concrete infrastructure commands must
exist only in runtime configuration. The bot token is read only from
`NAIA_DISCORD_BOT_TOKEN`.

Run:

```bash
npm run validate:naia
```

The validator rejects example values, malformed Discord snowflakes, a missing
bot token, a workspace whose remote is not `nextain/naia.land`, and an
unapproved role.

## Discord routing

Use one Naia application token and one gateway consumer. A shared-channel
request requires a mention and an open GitHub issue. Create one Discord thread
per GitHub issue and record its reference in that issue. Direct messages only
select a registered workspace and grant no additional authority. A second
gateway instance for the same token must refuse to start.

## Development deployment

The deploy command performs these steps in order:

1. Validate the ignored runtime configuration.
2. Require an open issue, matching issue branch, clean workspace, integration
   ancestry, non-empty committed change, and the `integrator` role.
3. Acquire the Naia development mutation lease.
4. Materialize rollback before any deployment command runs.
5. Export the committed revision to a clean temporary artifact directory.
6. Run the runtime deploy, reload, and cache invalidation commands.
7. Prove the serving revision and verify status, body size, and required content
   twice consecutively.
8. Release the lease only after success. On failure, execute the bound rollback
   and retain the lease record for operator inspection.

Production deployment and database writes are intentionally unavailable.

The current repository has no remote `dev` branch. Development deployments
therefore use committed issue branches based on `origin/main`; the target
environment remains development and this does not authorize a production
deployment.
