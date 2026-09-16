# LIFTY API agent operations

DigitalOcean App Platform is the primary hosted runtime. Agents should use the
checked-in npm commands instead of copying app IDs, ingress URLs, or app specs
into prompts:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:smoke
npm run do:deploy -- <full-40-character-sha>
```

These are alternatives for the relevant operation, not a checklist to run on
every release. Merging runtime changes to `main` already starts the `Deploy`
workflow: follow that run instead of invoking `do:deploy` again. The workflow
runs `npm run verify`, checks the exact active commit and runs the public smoke
suite. Reuse that evidence; add a focused authenticated/compatibility probe only
when the changed behavior requires it. Preserve any database-first dependency.
Human documentation-only pushes do not deploy; packaged Markdown under `src/`
still does. For local human documentation changes, prose/link/diff checks are
enough. Code and deploy-tooling changes require `npm run verify`; reuse a passing
result for unchanged inputs instead of rerunning before each commit.

`do:deploy` is pinned to `lifty-api-staging`, its single `api` component, the
LIFTY API GitHub repository, and `main`. It verifies that the supplied SHA is
the current remote branch head, starts a dedicated deployment without
reapplying the app spec, waits, verifies the exact active commit, and runs the
public smoke suite. It does not upload unpushed local changes. An optional
`LIFTY_DO_APP_ID` is treated as an assertion and must match the app resolved by
name.

Build reuse is enabled by default. Use `do:deploy -- <full-sha> --force-rebuild`
only when diagnosing a stale build/cache or when a clean rebuild is explicitly
required. Unknown deploy flags are rejected. A successful `do:deploy` already
includes status and smoke checks; do not repeat them immediately afterward.

`do:logs` intentionally accepts only bounded `--tail N` and `--type TYPE`
options. Agents must not forward global `doctl` credential, config, or trace
flags through the repository script.

Never print the live app spec or environment values into logs. A machine or
agent needs `doctl`, `jq`, `curl`, and an authenticated DigitalOcean context;
deploys additionally need `git`. `npm run do:doctor` verifies the runtime
prerequisites without exposing the token.

Do not run authenticated provisioning canaries until `do:status` and the
Linear issue confirm that the app targets a non-production Supabase project.
Public health and fail-closed authentication smoke checks are safe.
