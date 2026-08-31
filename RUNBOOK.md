# LIFTY REST control-plane playbook

## Architecture and trust boundary

```text
lifty CLI ── bearer JWT ──> lifty-api ── same JWT / RLS ──> Supabase RPCs
    │                             │
    └──── Supabase Auth only ─────┘
```

The CLI still uses Supabase Auth to sign in and refresh its session. Workspace
reads and writes go only through this API. The API verifies the JWT against the
project JWKS, creates a user-scoped Supabase client, and delegates to:

- `public.get_lifty_workspace_status()`
- `public.provision_lifty_workspace(draft jsonb)`

The database remains responsible for actor identity (`auth.uid()`), RLS,
validation, idempotency, advisory locking, and atomic provisioning. The service
does not duplicate that business logic.

The request-scoped Supabase client aborts each database request after 10 seconds.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL; HTTPS except for loopback development |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable Data API key used by the scoped client |
| `SUPABASE_JWKS_URL` | HTTPS JWKS endpoint; alternatively set inline `SUPABASE_JWKS` |
| `HOST` | Bind host, default `0.0.0.0` |
| `PORT` | Bind port, default `3000` |

Never inject `SUPABASE_SECRET_KEY`, `SUPABASE_SECRET_KEYS`, or
`SUPABASE_SERVICE_ROLE_KEY`; startup fails when one is populated. TLS
termination and per-IP/per-token rate limiting belong at the deployment ingress.

## Deploy and verify

1. Build the included container and deploy it as an ordinary Node service.
2. Configure only the publishable Supabase values above.
3. Keep the service private from browser integrations; no CORS allowlist is
   emitted.
4. Verify liveness and the public contract:

   ```sh
   curl --fail https://api.example.com/healthz
   curl --fail https://api.example.com/readyz
   curl --fail https://api.example.com/openapi.json
   ```

5. Verify authentication fails closed:

   ```sh
   curl --fail-with-body https://api.example.com/v1/workspace
   # Expected HTTP 401 with error.code = UNAUTHORIZED
   ```

6. Set `LIFTY_API_URL=https://api.example.com` in the CLI distribution and run
   `lifty status`, then a provisioning smoke test with a disposable founder.

Logs contain request ID, method, path, status, and public error code. They must
not contain bearer tokens, request bodies, onboarding drafts, or database error
details.

## Environments and migration flow (LIF-625)

LIFTY runs on its own dedicated Supabase projects, never on the internal GTM
Engine catalog:

| Environment | Supabase project | Runtime |
| --- | --- | --- |
| Staging | `siafcvcdhenahviuoxer` (`https://siafcvcdhenahviuoxer.supabase.co`) | `lifty-api-staging` on App Platform |
| Production | not created yet | not created yet |

This repository owns the LIFTY schema: `supabase/migrations/` is the canonical
migration root for both environments. There is no staging branch. All work
merges to `main`; the environments differ only in configuration:

1. A migration merges to `main` as a file in `supabase/migrations/`.
2. The `supabase-staging` workflow applies it to LIFTY Staging automatically
   (`supabase db push` against the `SUPABASE_STAGING_DB_URL` secret).
3. Verify on staging.
4. Promote by dispatching the `supabase-prod` workflow (type `promote`), which
   applies the same files to production. Until LIFTY Production exists and the
   `SUPABASE_PROD_DB_URL` secret is set, that workflow fails fast on purpose.

Never apply this migration root to the GTM Engine project, and never apply the
GTM catalog here. If a migration is ever applied out-of-band (MCP, psql), the
ledger row in `supabase_migrations.schema_migrations` must be restamped to the
file's `YYYYMMDDHHMMSS` version or the next `db push` will refuse to run.

Database passwords are held only as the `SUPABASE_*_DB_URL` GitHub secrets
(session-pooler URIs). Losing one is not an incident: reset the database
password in the Supabase dashboard and update the secret.

## DigitalOcean staging (primary)

The primary hosted runtime is the `lifty-api-staging` App Platform app. The
repository exposes the normal operational workflow through npm so agents do
not need a memorized app ID or dashboard-only steps:

```sh
npm run do:doctor
npm run do:status
npm run do:logs -- --tail 200
npm run do:smoke
```

`do:logs` defaults to the last 100 runtime lines. For a bounded, agent-safe
query it accepts only `--tail N` and `--type TYPE`; unsupported or global
`doctl` flags fail closed.

After a reviewed commit is available on the source branch configured in App
Platform, deploy and wait for verification with:

```sh
npm run do:deploy -- <full-40-character-sha>
```

The deploy command resolves the app by name and validates its ID, single API
component, GitHub repository, and `main` branch before mutation. It requires
the supplied SHA to match the remote branch head, creates a dedicated App
Platform deployment without reapplying the live app spec, waits, verifies the
exact active commit, and runs health, readiness, OpenAPI, and unauthenticated
fail-closed checks. It never prints environment values or uploads local files.

Agents need `doctl`, `jq`, and `curl`, plus an authenticated DigitalOcean
context; deploys additionally need `git`. Run `npm run do:doctor` first on a
new machine. The optional `LIFTY_DO_APP_ID` variable is an additional
assertion; it cannot redirect the script to another app.

Do not run authenticated provisioning canaries unless the app is connected to
a non-production Supabase project. Public smoke checks remain safe because
they perform no persistent writes.

## Vercel adapter (portable fallback)

The repository retains the Vercel adapter added during rollout exploration.
It adapts the configured Hono app through `api/index.ts` on the Node runtime
and rewrites all paths to that single function. DigitalOcean remains the
primary runtime and executes the Dockerfile; the adapter is a fallback, not a
second source of truth. The static output is intentionally limited to
`public/robots.txt` so compiled service files are not web-accessible.

Stable staging endpoint: `https://lifty-api-staging.vercel.app`

1. Link the checkout to the dedicated `lifty-api-staging` Vercel project.
2. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
   `SUPABASE_JWKS_URL` for Preview and Production. Do not configure any secret
   or service-role key.
3. Run `vercel deploy` for a protected preview canary, then `vercel deploy
   --prod` to update the stable public staging alias.
4. Run the health, readiness, OpenAPI, and unauthenticated fail-closed probes
   above against the stable endpoint before configuring `LIFTY_API_URL` for a
   CLI canary. Also verify a compiled path such as `/app.js` returns `404`.

The 2026-08-31 staging cut verified `GET /healthz` and `GET /readyz` at `200`,
OpenAPI `3.1.0`, absent and malformed bearer tokens at `401`, and `/app.js` at
`404`. Runtime logs contained only method, path, status, and platform metadata;
no bearer token or request body was emitted.

## Rollback

The service introduces no database migration. Roll back the CLI release to the
previous direct-RPC build, or remove `LIFTY_API_URL`, while leaving the API
deployed for investigation. Existing LIF-607 idempotency makes a same-draft
provisioning retry safe across the cutover.
