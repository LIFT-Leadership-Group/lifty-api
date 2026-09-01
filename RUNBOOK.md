# LIFTY REST control-plane playbook

## Architecture and trust boundary

```text
lifty CLI ── bearer JWT ──> lifty-api ── same JWT / RLS ──> Supabase RPCs
    │                             │
    └──── Supabase Auth only ─────┴── hosted OAuth ──> HubSpot
```

The CLI still uses Supabase Auth to sign in and refresh its session. Workspace
reads and writes go only through this API. The API verifies the JWT against the
project JWKS, creates a user-scoped Supabase client, and delegates to:

- `public.get_lifty_workspace_status()`
- `public.create_lifty_workspace(name text, description text)`
- `public.provision_lifty_workspace(draft jsonb)` — deprecated by LIF-655; push path until P4.2
- `public.create_lifty_hubspot_connect_intent()`
- `public.get_lifty_hubspot_connection()`

The browser callback exchanges and immediately refreshes the HubSpot grant,
verifies the exact reviewed scopes and portal, and persists it through the
one-use capability RPC. The API holds the HubSpot app secret but no Supabase
service-role credential; founders and CLI responses never receive provider
tokens.

`GET /cli/auth` is hosted by this same DigitalOcean service. Its browser code
uses only the Supabase URL and publishable key, keeps session tokens in memory,
and can POST them only to the exact `127.0.0.1` port supplied by `lifty login`.
The production CLI embeds the DigitalOcean ingress for both app and API URLs.

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
| `PUBLIC_BASE_URL` | Exact HTTPS DigitalOcean ingress used for OAuth redirects |
| `HUBSPOT_CLIENT_ID` | Client ID for the reviewed HubSpot LIFTY app |
| `HUBSPOT_CLIENT_SECRET` | Encrypted app-level secret for the HubSpot LIFTY app |
| `HOST` | Bind host, default `0.0.0.0` |
| `PORT` | Bind port, default `3000` |

Never inject `SUPABASE_SECRET_KEY`, `SUPABASE_SECRET_KEYS`, or
`SUPABASE_SERVICE_ROLE_KEY`; startup fails when one is populated. TLS
termination and per-IP/per-token rate limiting belong at the deployment ingress.

## Deploy and verify

1. Build the included container and deploy it as an ordinary Node service.
2. Configure the publishable Supabase values and encrypted HubSpot app values
   above. Backend environment variables are deployment configuration; founders
   do not set anything locally.
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

6. Confirm the CLI distribution embeds this DigitalOcean ingress, then run
   `lifty status`, a provisioning smoke test, and `lifty connect hubspot` with
   a disposable founder. No founder environment override should be present.

Logs contain request ID, method, path, status, and public error code. They must
not contain bearer tokens, request bodies, onboarding drafts, or database error
details.

## Environments and database (decision 2026-08-31, LIF-617)

LIFTY runs on the GTM engine Supabase project (`ycwarkyijoeunmgjbikm`,
`https://ycwarkyijoeunmgjbikm.supabase.co`). The dedicated LIFTY Supabase
boundary built under LIF-625 was rejected and deleted the same day; do not
recreate it. Tenant isolation for founder JWTs is enforced inside the shared
catalog (RLS by workspace, locked-down grants, backend-only secrets) under the
LIF-617 track.

This repository carries no migration root. The LIFTY schema (workspaces,
memberships, onboarding submissions, provisioning RPCs from LIF-607) lives in
the GTM engine migration ledger and changes through the same flow as every
other GTM engine migration. The only Supabase configuration this repo owns is
the runtime environment of the App Platform app (`SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL`). HubSpot app credentials and
`PUBLIC_BASE_URL` are also owned by that DigitalOcean runtime.

## DigitalOcean staging

The sole hosted runtime is the `lifty-api-staging` App Platform app. The
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

Authenticated canaries use disposable founder accounts and workspaces and must
follow the LIF-628 cleanup receipt. Public smoke checks remain safe because
they perform no persistent writes.

## Rollback

The database migrations live in the GTM engine repository, not here. Roll back
the DigitalOcean deployment to the previous exact commit and mark affected
HubSpot connections `reconnect_required` if a provider-grant regression is
suspected. Existing provisioning idempotency makes a same-draft retry safe.
