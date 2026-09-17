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
- `public.submit_lifty_onboarding(draft jsonb)` — draft-gated push receipt (LIF-656)
- `public.get_lifty_onboarding_status()` — import status + secret-free summary (LIF-656)
- `public.start_lifty_run()` — first ICP run start with the platform Apollo default (LIF-657)
- `public.get_lifty_run_status()` — run state + researched results (LIF-657)
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
| `SLACK_CLIENT_ID` | Client ID for the Slack OAuth app |
| `SLACK_CLIENT_SECRET` | App-level secret for Slack OAuth |
| `TRIGGER_SECRET_KEY` | Trigger.dev prod secret key used to enqueue `lifty-onboarding-import` |
| `TRIGGER_API_URL` | Optional; defaults to `https://api.trigger.dev` |
| `HOST` | Bind host, default `0.0.0.0` |
| `PORT` | Bind port, default `3000` |

Never inject `SUPABASE_SECRET_KEY`, `SUPABASE_SECRET_KEYS`, or
`SUPABASE_SERVICE_ROLE_KEY`; startup fails when one is populated. TLS
termination and per-IP/per-token rate limiting belong at the deployment ingress.

## Deploy and verify

Merging runtime changes to `main` starts the `Deploy` GitHub Actions workflow.
Follow that run: it runs `npm run verify`, deploys the exact main SHA, waits for
it to become active, and probes health, readiness (including CRM), OpenAPI and
fail-closed authentication. Do not run a second deploy or repeat those public
probes after the workflow passes. Human documentation-only pushes are excluded;
Markdown shipped under `src/agent-context/` still triggers deployment.

Configure the publishable Supabase and encrypted HubSpot values above when
setting up the host; founders do not set them locally. Keep the service private
from browser integrations (no CORS allowlist). Release prerequisite migrations
through their owning CI before merging the dependent API. For LIF-897, deploy
its database capability and replay ledger first, then the Jobs task
`lifty-crm-mapping-sync`, then this API. The public smoke checks both
`/readyz/crm` (`lifty-crm-company.v1`) and `/readyz/crm-mapping`
(`lifty-crm-mapping.v1`); these verify static database capabilities without
reading a tenant or contacting HubSpot. Worker deployment is a separate
prerequisite, verified by its owning release workflow.

If a change affects CLI ingress, provisioning or HubSpot onboarding, verify that
specific behavior with the matching CLI and a disposable nonproduction founder,
following the canary constraints below. Do not run the entire provisioning flow
for documentation or deploy-tooling changes.

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

For an intentional manual redeploy when no CI deployment is already running,
use the reviewed current main SHA and wait for verification with:

```sh
npm run do:deploy -- <full-40-character-sha>
```

The deploy command resolves the app by name and validates its ID, single API
component, GitHub repository, and `main` branch before mutation. It requires
the supplied SHA to match the remote branch head, creates a dedicated App
Platform deployment without reapplying the live app spec, waits, verifies the
exact active commit, and runs health, readiness, OpenAPI, and unauthenticated
fail-closed checks. Eligible builds can be reused; append `--force-rebuild`
only when a clean rebuild is required or to diagnose stale build/cache state.
Unknown flags are rejected. It never prints environment values or uploads local files.

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

## Request limits

`POST /v1/workspace`, `POST /v1/onboarding`, and `POST /v1/workspace/runs` share a budget of ten requests per authenticated user per minute per API process. Exhaustion returns 429 `RATE_LIMITED` with `Retry-After`. The in-memory budget resets on restart and is not shared across replicas. Per-IP and fleet-wide limiting belong at ingress. Reads and OAuth callbacks do not consume this budget.
