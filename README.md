# LIFTY Control Plane and OAuth API

The LIFTY CLI-facing REST boundary for workspace status, provisioning, and
hosted provider connections. It is a standalone Hono service that authenticates
Supabase user JWTs and invokes the existing LIFTY RPCs through a request-scoped,
RLS-enforced Supabase client.

The process deliberately has no Supabase secret key or service-role client. It
refuses to start if a known secret-key environment variable is populated.

`src/server.ts` is the long-running Node/container entrypoint used by the sole
hosted runtime on DigitalOcean App Platform. `src/index.ts` constructs the same
configured Hono app for programmatic use.

## API

- `GET /healthz` — liveness
- `GET /readyz` — process readiness after configuration and app construction
- `GET /openapi.json` — generated OpenAPI 3.1 contract
- `GET /cli/auth` — hosted founder sign-in and loopback CLI authorization
- `GET /v1/workspace` — authenticated founder workspace state
- `POST /v1/workspace` — authenticated, idempotent workspace creation at login (LIF-655)
- `POST /v1/onboarding` — authenticated draft submission; queues one onboarding-import run (LIF-656)
- `GET /v1/onboarding` — authenticated import status with a secret-free config summary
- `POST /v1/workspace/runs` — start (or re-attach to) the first ICP run of five leads (LIF-657)
- `GET /v1/workspace/runs` — run state, progress, and researched results
- `GET /v1/status` — one aggregate read for `lifty status`: workspace, onboarding import, first run, latest config update, and per-provider connection + last sync (LIF-669). Never touches OAuth.
- `GET /v1/config` / `GET /v1/config/{section}` — secret-free workspace config (`icp`, `tone`, `prompt`, `workspace`), each with a version stamp
- `PATCH /v1/config` — config update through the LIF-667 seam. Body: `{section, values}`, `{section: "prompt", instruction}`, or `{values}`. Filter/tone/workspace writes land synchronously; persona, tone, and prompt regenerations return `queued` and run through the `lifty-config-update` job (LIF-668). While one regeneration is queued any other change answers 409 `CONFIG_UPDATE_IN_FLIGHT`; re-sending the queued update re-attaches (LIF-681)
- `GET /v1/config/updates/{submission_ref}` — poll a queued update (state, changed sections, new versions, error code)
- `POST /v1/integrations/{provider}/connect` — mint a short-lived connect URL (`hubspot`; `unipile` is reserved and answers 501 until its connect path exists)
- `GET /v1/integrations/{provider}` — secret-free connection status
- `DELETE /v1/integrations/{provider}` — disconnect: deletes the stored grant, deactivates the integration, clears the portal pointer; 409 while a CRM sync is in flight. Founder confirmation is the skill's job (LIF-669)
- `POST /v1/integrations/{provider}/sync` / `GET …/sync` — start / poll the CRM sync run (LIF-663)
- `GET /hubspot/start` — redirect an opaque connect intent to HubSpot consent
- `GET /hubspot/callback` — verify OAuth, refreshability, scopes, and portal;
  persist the encrypted grant and render a safe browser result

The `/v1` endpoints accept `Authorization: Bearer <Supabase access token>`. No
CORS middleware is enabled: the intended consumer is the CLI, not arbitrary
browser origins. The two `/hubspot` routes are browser-facing but accept only a
ten-minute, one-use capability or HubSpot's authorization response; they never
render credentials or provider response bodies.

## Local development

Requirements: Node.js `>=22.11.0` and npm.

```sh
npm ci
cp .env.example .env
set -a
. ./.env
set +a
npm run dev
```

The service does not load `.env` itself. Export the variables through the shell,
container runtime, or local process manager. Use `SUPABASE_JWKS` instead of
`SUPABASE_JWKS_URL` when an inline JWKS is preferable.

```sh
npm run verify
docker build -t lifty-api .
```

See [RUNBOOK.md](./RUNBOOK.md) for deployment, smoke tests, and rollback.

DigitalOcean App Platform is the only hosted runtime. Agents can inspect or
operate it with `npm run do:doctor`, `do:status`, `do:logs`, `do:smoke`, and
`do:deploy -- <full-sha>`; the runbook documents the guardrails and
prerequisites.
