# LIFTY Control Plane API

The LIFTY CLI-facing REST boundary for workspace status and provisioning. It is
a standalone Hono service that authenticates Supabase user JWTs and invokes the
existing LIF-607 RPCs through a request-scoped, RLS-enforced Supabase client.

The process deliberately has no Supabase secret key or service-role client. It
refuses to start if a known secret-key environment variable is populated.

`src/server.ts` is the long-running Node/container entrypoint. `src/index.ts`
constructs the same configured Hono app, and `api/index.ts` adapts it to Vercel
Functions for Node-based staging; it is not an Edge runtime and does not change
the API or Supabase trust boundary.

## API

- `GET /healthz` — liveness
- `GET /readyz` — process readiness after configuration and app construction
- `GET /openapi.json` — generated OpenAPI 3.1 contract
- `GET /v1/workspace` — authenticated founder workspace state
- `POST /v1/workspaces` — authenticated, idempotent workspace provisioning

The `/v1` endpoints accept `Authorization: Bearer <Supabase access token>`. No
CORS middleware is enabled: the intended consumer is the CLI, not arbitrary
browser origins.

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

DigitalOcean App Platform is the primary hosted runtime. Agents can inspect or
operate it with `npm run do:doctor`, `do:status`, `do:logs`, `do:smoke`, and
`do:deploy`; the runbook documents the guardrails and prerequisites.
