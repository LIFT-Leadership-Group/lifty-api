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

## Rollback

The service introduces no database migration. Roll back the CLI release to the
previous direct-RPC build, or remove `LIFTY_API_URL`, while leaving the API
deployed for investigation. Existing LIF-607 idempotency makes a same-draft
provisioning retry safe across the cutover.
