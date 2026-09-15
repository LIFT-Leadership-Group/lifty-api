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
- `POST /v1/integrations/{provider}/connect` — mint a short-lived connect URL (`hubspot` or `slack`; `unipile` is reserved and answers 501 until its connect path exists)
- `GET /v1/workspaces/{workspace_ref}/integrations/apollo/key-source` — current Apollo source/configuration, no credentials
- `POST /v1/workspaces/{workspace_ref}/integrations/apollo/key-source` — `{operation:"platform_default"}` or `{operation:"own_key",api_key:"…"}`; current member of a LIFTY workspace only. Active acquisition and outstanding allowance reservations block changes. Exact retries are idempotent; previous secret identities remain intact. Requires the LIF-641 DB contract and Jobs LIF-680 reserve-before-key-load. Unipile own-key selection is not supported by this Apollo endpoint.
- `POST /v1/workspaces/{workspace_ref}/integrations/slack/connect-link` — admin-only seven-day client invitation for an explicit workspace; requires membership as well as LIFT admin status
- `GET /v1/integrations/{provider}` — secret-free connection status
- `DELETE /v1/integrations/{provider}` — disconnect: detaches the stored grant (unusable by LIFT from that moment), deactivates the integration, clears the portal pointer, and enqueues the `lifty-integration-revoke` job that revokes the grant at the provider best-effort and deletes the secret (LIF-681); 409 while a CRM sync is in flight. Founder confirmation is the skill's job (LIF-669)
- `POST /v1/integrations/{provider}/sync` / `GET …/sync` — start / poll the CRM sync run (LIF-663)
- `GET /hubspot/start` — redirect an opaque connect intent to HubSpot consent
- `GET /hubspot/callback` — verify OAuth, refreshability, scopes, and portal;
  persist the encrypted grant and render a safe browser result

- `GET /slack/start` — redirect a connect intent to Slack consent
- `GET /slack/callback` — validate Slack authorization and persist the grant
- `GET /v1/notifications` — notification configuration
- `GET /v1/notifications/slack/channels` — available Slack destinations
- `PUT /v1/notifications/destinations/slack` — configure a Slack destination
- `PUT /v1/notifications/routes` — configure notification routing
- `POST /v1/notifications/destinations/{destination_ref}/test` — test a destination

Slack disconnect deletes the stored Slack authorization directly; it has no HubSpot revocation job.

The `/v1` endpoints accept `Authorization: Bearer <Supabase access token>`. No
CORS middleware is enabled: consumers are the CLI and authenticated dashboard server actions. The four `/hubspot` and `/slack` OAuth routes are browser-facing but accept only a
one-use capability (ten minutes for founder connections, seven days for admin Slack invitations) or the provider's authorization response; they never
render credentials or provider response bodies.

New HubSpot connections require the exact LIFTY CRM contract: contacts,
companies, and deals read/write; contact and company property-schema
read/write; and the base `oauth` scope. Expanding the app contract does not
expand existing HubSpot refresh tokens, so older connections report
`reconnect_required` until the founder reconnects.

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

Admin Slack invitations reuse `/slack/start` and `/slack/callback`. Reissuing replaces unused Slack invitations only for the selected workspace. The database rechecks the issuer's admin status, membership, and workspace activity when the callback consumes an admin invitation. Store neither generated links nor OAuth tokens in logs or durable evidence. Deploy migration `20260914180009_lif639_admin_slack_connect_links.sql` before this API, then the dashboard Settings card.

## Hosted email connection (LIF-827)

The CLI uses `POST /v1/email/connect` with `{workspace, email, mailbox_use}` and
polls `GET /v1/email?workspace=<slug-or-id>`. Workspace membership is explicit;
it never relies on the operator's default workspace. `personal` means a mailbox
the founder already uses regularly, including business-domain mailboxes; its
recorded declaration exempts warmup. New/dedicated `outreach` mailboxes require
warmup. The profile fixes the configurable ceiling at 10 automated emails/day.
This connection slice does not send mail or enable sender/channel/default routes.
The actual atomic daily send budget and activation checks remain in LIF-828.

The browser goes through `/unipile/start` to a single-use Unipile email-only
hosted link without mailbox-history sync. `/unipile/callback` requires an opaque
intent and a server-generated correlation MAC, then independently rereads the
bound account ID, exact email and mail-source health before persisting anything.
It handles `CREATION_SUCCESS` and `RECONNECTED`. Revoked membership, suspended
workspaces, stale intents and identity changes fail closed; repeated completed
callbacks cannot reactivate a disconnected account.

Deployment order:

1. Apply `lif827_hosted_email_connections` in the GTM Engine migration root and
   align the source filename with the production ledger's actual version.
2. Generate a dedicated random `LIFTY_EMAIL_SERVER_KEY` (at least 32 characters)
   in the deployment secret manager. Provision only its SHA-256 digest plus the
   stable Unipile organization/credential namespace into
   `private.lifty_email_server_config`. The namespace is NOT the DSN. No seed
   config is shipped, so an unconfigured deployment remains closed.
3. Configure `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`, and that dedicated key in the
   API deployment. Never add a Supabase service-role key to this API. The new
   narrow RPC needs both the API key and current user membership (or a verified
   provider callback backed by the stored issuer).
4. Run the repository's verification/deployment scripts and publish a new CLI
   version through the existing reviewed release process. A merge alone does
   not publish or configure this feature. Existing CLI next.10 lacks the new
   flags until a new version is released.
5. Confirm with a real non-production mailbox, including reconnection and
   expired/forged callbacks. Unit HTTP contracts and SQL fixture tests are not
   live OAuth acceptance evidence.

LIF-827 still owns Mailivery warmup/placement evidence and durable activation
policy. LIF-828 must enforce the per-physical-mailbox 10/day budget atomically
across all automated sends, retries and workspace resets before any sending is
enabled. Personal-use exemption never invents historical warmup dates.


Acquisition recovery is explicit and asynchronous: GET `/v1/workspaces/{workspace_ref}/apollo/recovery/{first_run_ref}` reads status; POST `{operation:"request",expected_acquisition_ref:"UUID"}` requests authoritative task verification only. POST `{operation:"restart",expected_acquisition_ref:"UUID"}` restarts only the exact verified terminal acquisition, preserving the first-run cohort and historical allowance. Both mutations bind the selected workspace before SQL changes. Failed enqueue leaves its durable request/attempt intact; retry the same references. This requires the LIF-641 recovery DB/verifier deployment.

## Password recovery (LIF-837)

The hosted `/cli/auth` login includes **Forgot your password?**, opening a separate `/auth/password-reset` page. It requests recovery through the existing Supabase Auth public REST API. Known and unknown addresses receive the same success message; no email is retried automatically.

Configure this single exact Supabase Auth redirect URL for the deployed `PUBLIC_BASE_URL`:

```text
https://lifty-api-staging-ox2h9.ondigitalocean.app/auth/password-update
```

Preserve the existing Site URL, other redirect entries and SMTP configuration. The recovery email template must use Supabase's normal recovery confirmation URL so Auth verifies its one-time recovery token and redirects to the supplied `redirect_to`. A template that hardcodes SiteURL, strips the fragment or converts to PKCE requires a separate configuration correction; this implementation does not accept an arbitrary return URL.

Recovery uses the documented implicit flow so the email can open in another browser without a stored PKCE verifier. `/auth/password-update` removes its URL fragment/query immediately, checks its recovery access token against `GET /auth/v1/user`, and lets the owner choose/confirm a new password via `PUT /auth/v1/user`. It keeps no recovery token in local/session storage or cookies, discards the refresh token, and makes a best-effort `POST /auth/v1/logout?scope=local` after success. Supabase access JWTs may remain valid until expiry; this does not promise absolute token revocation or terminate other sessions.

The recovery page never calls the CLI loopback endpoint or grants workspace access. After changing the password, return to the original login tab and sign in/approve normally, or run `lifty login` again if that request expired. The CLI's original nonce, origin and fixed loopback-port checks are unchanged. Closing/reloading the recovery page loses its in-memory session; request a fresh link. Password-update network/server ambiguity reports that the change may have happened and does not replay it.

Validation: browser-script tests execute the delivered inline JavaScript against mocked Auth REST responses, plus public-route/CSP and production-composition checks. They do not prove live email delivery or project Auth configuration. A live test must be performed by the account owner after deploying and allowlisting the exact URL; only the owner enters the new password.

Primary contracts: [password recovery guide](https://supabase.com/docs/guides/auth/passwords), [Auth REST schema](https://github.com/supabase/auth/blob/master/openapi.yaml), [official Auth client recovery/transport](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts), [redirect allowlist](https://supabase.com/docs/guides/auth/redirect-urls). No mandatory email-verification or leaked-password setting is introduced.
