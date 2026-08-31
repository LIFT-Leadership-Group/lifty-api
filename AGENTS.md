# LIFTY API agent operations

DigitalOcean App Platform is the primary hosted runtime. Agents should use the
checked-in npm commands instead of copying app IDs, ingress URLs, or app specs
into prompts:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:logs -- --follow
npm run do:smoke
npm run do:deploy
```

`do:deploy` resolves the app by `lifty-api-staging`, exports its current remote
spec into a private temporary directory, updates from the configured source
branch, waits for the deployment, prints the exact deployed commit, and runs
the public smoke suite. It deploys remote source; it does not upload unpushed
local changes. Override resolution only with `LIFTY_DO_APP_NAME` or an exact
`LIFTY_DO_APP_ID`.

Never print the live app spec or environment values into logs. A machine or
agent needs `doctl`, `jq`, `curl`, and an authenticated DigitalOcean context;
`npm run do:doctor` verifies these prerequisites without exposing the token.

Do not run authenticated provisioning canaries until `do:status` and the
Linear issue confirm that the app targets a non-production Supabase project.
Public health and fail-closed authentication smoke checks are safe.
