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

### Agent task context

`GET /v1/context/stages` indexes the ten configuration stages. Each
`GET /v1/context/{stage}` returns current public Markdown, references, schemas
and named operation routes. The onboarding/workspace/campaign entry contexts
remain available. Public context works before login and contains no tenant
values or Scout base.

The only supported client contract is `lifty-cli-context.v5`. The CLI requests
it through the public context query parameter `client_contract` and sends
`x-lifty-client-contract: lifty-cli-context.v5` on every authenticated API call.
Explicit v1–v4 or unknown context profiles return HTTP 409
`CONTEXT_CLIENT_UNSUPPORTED` with upgrade guidance. Unversioned public links
show current documentation. After authentication, private `/v1/*` requests
with a missing, retired or unknown contract also return 409 before business
handlers. Invalid sessions still return 401. Health, login and provider browser
callbacks retain their existing bootstrap/consent behavior.

This intentionally retires the frozen v4 guides and older compatibility
profiles during internal testing (LIF-896). Upgrade the installed CLI/skill
before resuming a retired client, preserving private drafts and configuration.
The current v5 CLI already supplies the required header, so this API change
requires no v5 npm update. The JSON envelope remains `lifty-context.v1`; that
format is separate from the retired client profile names.

Edit task guidance in `src/agent-context/`. Stage transport fetches fresh
context on each invocation, resolves its method/route, and passes business
inputs/responses through. Business validation remains in the API/RPCs. Private
context at `/v1/onboarding/context` and `/v1/config/context` supplies generation
rules, artifact schemas and workspace fingerprints. Ordinary stage guide,
schema and route changes work with the same v5 installed artifact. Changing
CLI transport, bootstrap or local helpers can still require a client release.
A content revision is not authorization to mutate a workspace.

Build replaces `dist/agent-context/` with the current public assets, removing
retired guides from incremental builds. If context retrieval fails, preserve
local work and stop dependent writes instead of using stale instructions.

### Routes

- `GET /healthz` — liveness
- `GET /readyz` — process readiness after configuration and app construction
- `GET /openapi.json` — generated OpenAPI 3.1 contract
- `GET /v1/context/{task}` — public task guidance for onboarding, workspace or campaign
- `GET /cli/auth` — hosted founder sign-in and loopback CLI authorization
- `GET /v1/workspace` — authenticated founder workspace state
- `POST /v1/workspace` — authenticated, idempotent workspace creation at login (LIF-655)
- `POST /v1/onboarding` — authenticated `{draft, configuration}` submission; queues deterministic validation and application of locally generated ICP/Scout configuration (LIF-851). Missing configuration fails with `LOCAL_CONFIGURATION_REQUIRED`; no server agent fallback.
- `GET /v1/onboarding/context` — authenticated founder-scoped workspace and Scout rules for local generation; includes the contract and context versions required by the push. Includes server-owned `generation_rules` and `configuration_schema` for the local agent. Refresh and regenerate on `ONBOARDING_CONTEXT_STALE`.
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

The browser goes through `/unipile/start` to a single-use Unipile Gmail-only
hosted link without mailbox-history sync. Gmail includes Google Workspace
addresses on corporate domains; the authenticated provider determines eligibility.
Outlook and IMAP/SMTP are unsupported in v1. Account readback enforces this
restriction for callbacks, reconnections and status recovery, including old links.
`/unipile/callback` requires an opaque
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

### Hosted connection domain

Email and LinkedIn browser handoffs support `UNIPILE_HOSTED_AUTH_ORIGIN`.
When unset, they use `https://account.unipile.com`. To enable a Lifty domain:

1. Create `connect.liftygtm.com` as a CNAME to `account.unipile.com`.
2. Ask Unipile support to activate the V1 hosted domain and issue its TLS
   certificate. Verify public DNS and HTTPS before changing the API setting.
3. Set `UNIPILE_HOSTED_AUTH_ORIGIN=https://connect.liftygtm.com` on the API
   deployment. It accepts only an HTTPS DNS origin, with no credentials,
   non-default port, path, query or fragment.
4. Verify new and resumed email/LinkedIn handoffs, then real account
   authorization and reconnection in the designated test workspace.

The provider and database continue using canonical Unipile URLs. Only the
browser redirect hostname changes; the session path/query, signed callbacks,
identity readback and account permissions remain intact. No database migration
or CLI update is required. Roll back by removing `UNIPILE_HOSTED_AUTH_ORIGIN`
and deploying the configuration; existing unexpired intents remain usable.

Custom domains do not establish logo removal or change Google/Microsoft's OAuth
consent branding. Confirm V1 page branding separately with Unipile. Do not
change shared OAuth credentials or migrate to V2 to enable this setting.

LIF-827 still owns Mailivery warmup/placement evidence and durable activation
policy. LIF-828 must enforce the per-physical-mailbox 10/day budget atomically
across all automated sends, retries and workspace resets before any sending is
enabled. Personal-use exemption never invents historical warmup dates.

## Mailivery warmup (LIF-989)

The hosted email form now asks how the founder uses the mailbox. `personal`
stays the default. `outreach` (a new or dedicated account) is accepted and
means warmup is required: outreach unlocks only after 21 active warmup days
with a healthy check from the last 24 hours. Paused days do not count.

Routes, all bound to the caller's session and an explicit workspace:

- `GET /v1/email/warmup?workspace=<slug-or-id>` returns state, active days
  N of 21, today's warmup volume and ramp target, SPF/DMARC/MX, last check
  time, a plain-words blocking reason and `recommended_go_live`.
- `POST /v1/email/warmup/start` `{workspace}` calls
  `lifty_email_warmup('start')`. Only while the binding is `link_issued`
  (no Mailivery campaign bound yet) it mints a hosted Mailivery form URL tagged
  `lifty-ws:<workspace_ref>` and `lifty-sender:<sender_ref>`; `expires_at`
  comes from the signed URL's own `expires` claim. Without a verified email
  connection the database answers `email_connection_required`. A
  `pending_consent` binding already has its campaign, so `start` returns status
  and tells the founder to finish Microsoft consent in Mailivery; a second form
  would create another billed campaign. A mailbox warmed from another
  workspace fails with `email_warmup_mailbox_taken`.
- `POST /v1/email/warmup/pause|resume|remove` `{workspace}` record the
  requested action. The jobs worker applies it at the provider.

Configure `MAILIVERY_API_KEY` in the API deployment to enable `start`. Without
it `start` returns `EMAIL_WARMUP_NOT_CONFIGURED` before any write. The API never
logs the key, the signed URL or Mailivery response bodies. Deploy the
`lifty_email_warmup` founder RPC migration before this API.


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

## LinkedIn v1 control plane (LIF-844)

`POST /v1/linkedin/connect` accepts only the workspace, founder IANA timezone,
`account_use: "personal"`, and `other_automation: false`. The declaration means
an account the founder uses regularly and does not automate with another tool.
The API returns a short-lived URL under `/unipile/linkedin/start`; the browser
uses a single-use, LinkedIn-only Hosted Auth link. It does not inherit the email
provider picker or MAILING synchronization options.

The signed intent and callback correlation MAC have LinkedIn-specific purposes.
`/unipile/linkedin/callback` records an immutable account hint, then verifies
`GET /api/v1/accounts/{account_id}` and `GET /api/v1/users/me?account_id=...` using
the provider credential. Both responses must identify LinkedIn and the same
profile; every source must have a unique nonblank ID and `OK` health. Only the
selected profile ID, safe profile URL and display name cross the API boundary.
A callback body never establishes identity by itself. A provider outage keeps
the hint so authenticated `GET /v1/linkedin?workspace=...` can finish readback.
Workspace membership is checked before reconciliation and again by completion.

Status verifies account health and writes unhealthy or unverifiable readback to
the connection through a caller-scoped RPC. Disconnect accepts
`{ "workspace": "slug-or-id", "confirm": true }` at
`POST /v1/linkedin/disconnect`; it pauses the durable connection and campaigns.
Connection, healthy recovery and reconnect do not activate outbound. A healthy,
already active account may truthfully report `sending_enabled: true`; every
new or reconnecting account stays inactive until explicit campaign activation.

`POST /v1/linkedin/campaign` accepts `{ "operation": ..., "payload": ... }`:

| Operation | Payload |
| --- | --- |
| `prepare` | `workspace`, `lead_id`, `connection_ref`, exact plain-text `text` (1–3000 characters), optional `campaign_ref` |
| `preview`, `status` | `workspace`, `campaign_ref` |
| `approve`, `activate`, `pause`, `cancel` | `workspace`, `campaign_ref`, exact `digest`, `confirm: true` |

The preview fixes an invitation without a note, followed by one message after
verified acceptance. It includes the exact message, recipient, connection,
version, digest, policy, action outcomes and blockers. A material change creates
a new version and invalidates approval. Delivery receipts and uncertain outcomes
remain inspectable; the API does not send or retry an invitation or message.
The backend owns atomic reservations: 5 invitations/day, 25 invitations in a
rolling 7 days, 5 messages/day, weekdays 09:00–17:00 in the founder timezone,
and 15–45 minute spacing. There are no extra steps or editable schedules.

### Workspace retirement limitation

LinkedIn v1 cannot retire a workspace with a bound LinkedIn account or retained
LinkedIn history. Retirement returns `409 WORKSPACE_LINKEDIN_RETENTION_REQUIRED`.
Disconnecting LinkedIn stops sending but preserves account records and historical
sending limits; it does not remove this retirement guard. Retention-safe workspace
retirement needs a separate change.

### Deployment and acceptance

1. Apply the LIF-844 SQL migration, retaining the existing account/action ledger,
   canonical `lead_events` and cross-channel reply/suppression guards.
2. Provision a random `LIFTY_LINKEDIN_SERVER_KEY` of at least 32 characters and
   its SHA-256 digest plus the stable Unipile namespace in
   `private.lifty_linkedin_server_config`. Use a key different from email.
3. Configure that key, `UNIPILE_DSN` and `UNIPILE_ACCESS_TOKEN` in the API. Either
   channel can be enabled independently. The API rejects service-role Supabase
   credentials. Member operations keep the caller JWT and the dedicated RPC
   capability; browser operations recheck the durable intent issuer in SQL.
4. Deploy the matching SQL, Jobs/Edge runtime and API commits and publish the
   CLI through the existing release process. Inspect `/openapi.json` for the
   strict public contracts. A local commit does not enable sending.
5. Run the explicitly authorized account/recipient acceptance journey and
   record invite, acceptance, message and reply receipts and canonical events.
   Confirm paused recovery, cross-tenant isolation, no duplicate events/sends,
   cross-channel stop and zero accidental pending work before founders.

`npm run verify` covers mocked HTTP/provider shapes, purpose separation,
callbacks, caller-scoped RPCs, public schemas and the existing email regression
suite. These tests do not claim live Hosted Auth or recipient delivery acceptance.

Provider contracts checked: [account readback](https://developer.unipile.com/reference/accountscontroller_getaccountbyid),
[own-profile readback](https://developer.unipile.com/reference/userscontroller_getaccountownerprofile),
[Hosted Auth](https://developer.unipile.com/docs/hosted-auth).

Onboarding publication runs a deterministic linter before storing a receipt or queuing a job. A `422 LOCAL_CONFIGURATION_INVALID` response includes up to 20 `error.issues` entries with `{code, path, message, suggestion}`; paths are JSON pointers rooted at `/configuration` or `/draft`. The local agent can repair technical issues and push again. Diagnostics never include submitted targeting values or prompt text. Checks cover schema, confirmed personas/titles, employee bounds, Apollo seniorities, duplicates, required Scout sections, the 52,000 character budget, and copied global Scout instructions. Semantic fit still depends on the founder-confirmed draft.

### Company mapping for the local agent

`GET /v1/integrations/hubspot/company-mapping/context?workspace_ref=<uuid>` returns current portal properties, mappings, task instructions and the candidate schema. The optional workspace selector requires current membership and a supported active Lifty workspace; omission retains the single-workspace default. `POST /v1/integrations/hubspot/company-mapping` executes the deterministic workflow in **lifty-api**. The local agent calls the CLI, the CLI calls this API, and the API uses HubSpot plus one narrowly authorized storage RPC. It no longer invokes the company Edge Function.

The API validates a locally generated plan, makes additive property changes, atomically inserts missing mappings and reads them back before returning `verified: true`. It has a 55-second operation deadline and 15-second provider request deadlines; the CLI allows 65 seconds. A timeout or partial provider failure requires fresh context before another apply. Existing operator mappings are never replaced.

`DASHBOARD_READ_ONLY_MODE=1` or `CONSUMER_READ_ONLY_MODE=true` blocks apply with `503 MAINTENANCE_READ_ONLY` before storage/provider calls, while context stays readable. Configure the same maintenance flag on the API service when cutting over from Edge; deployment environments are separate.

Storage requires **both** the caller's verified user JWT/current workspace membership and a separate `LIFTY_CRM_SERVER_KEY`. This capability permits only company mapping state/publication and the selected integration's credential resolution/rotation/reconnect state. It grants no arbitrary SQL, Vault or tenant access. The API remains forbidden from holding a Supabase service-role key. Credentials are parsed by the shared HubSpot grant policy, portal-bound before provider writes, and rotation uses a credential-version compare-and-swap.

Rollout: apply `20260916115048_lif858_company_api_capability.sql`, provision a cryptographically random dedicated key in API secret configuration and only its SHA-256 in `private.lifty_crm_server_config`, then deploy the API. `/readyz/crm` must return `{status:"ready",capability:"lifty-crm-company.v1"}`; `scripts/digitalocean.sh smoke` enforces that independently of general health. It validates the installed RPC/version/key without reading tenant data or contacting HubSpot. A missing/mismatched key fails this probe and company requests return 503. Release the matching CLI after verifying an authenticated workspace context/apply/readback canary. Keep the old Edge deployment only for rollback during this rollout; disable/remove it after API cutover is verified. Never copy production tokens into canary output.

#### Company cutover rollback

1. Set `CONSUMER_READ_ONLY_MODE=true` in the API deployment to stop new company apply operations. Context remains available; already accepted HubSpot changes require a fresh readback.
2. Keep the additive CRM migration and the previously deployed Edge Function. Do not roll back the entire API once new receipt/config Jobs are live: older API schemas cannot read their contracts.
3. Prepare a forward rollback on a branch from **current main**: revert only the native company migration commit (`11cf448`, excluding later receipt/config changes), resolve integrations with the current tree, and restore the previous caller-scoped Edge adapter. Keep company apply frozen while validating. The rollback restores the old single-workspace behavior; explicit multi-workspace requests must fail clearly instead of selecting another workspace.
4. Run `npm run verify`, verify the restored Edge with an authenticated nonproduction context/apply/readback canary, and merge the reviewed rollback. Deploy its **new main SHA** by following the automatically triggered `Deploy` workflow. Use `bash scripts/digitalocean.sh deploy <full-new-main-sha>` only for an intentional manual redeploy, not alongside CI. The deployment script deliberately rejects old/non-head commits; do not bypass that protection. The company-only revert restores the previous smoke script (health, readiness, OpenAPI and failed-closed authentication); use the Edge canary as the company capability proof for this rollback, since that API revision has no native `/readyz/crm` route.
5. Remove the maintenance flag only after readback verifies the intended workspace/portal. Existing DB mappings and provider properties remain intact. Never delete additive provider fields to simulate a rollback.

Company setup guidance is served through the current v5 CRM stage context.
Earlier client profiles are retired; the response envelope remains
`lifty-context.v1`. The company mapping backend must be available before use.

### General CRM mapping and verified record links (LIF-897)

Current v5 clients discover the full mapper through `context crm`. Its
`mapping_catalog`, `mapping_sources`, `mapping_preview`, `mapping_apply`,
`property_create`, `mapping_sync` and `mapping_status` operations reuse the
existing CRM mapping contract. The bounded company onboarding flow remains
available. `records` returns contact/company links only after live identity
checks in the currently connected portal. Saved person location is distinct
from company headquarters; no enrichment purchase is part of these reads.

Mapping edits do not update records. Replay requires the selected cohort of
at most 25 leads, current scope/version, a fresh preview digest and a stable
request reference. The `lifty-crm-mapping-sync` worker uses the saved ledger
plan and reports per-field readback. Queue acceptance is not verified success.
Maintenance mode blocks mapping apply, property creation and replay submission;
read operations remain available.

Release the LIF-897 database migration through its owning CI, then deploy the
matching Jobs task before this API. The existing dedicated CRM capability key
also gates `lifty_crm_mapping_tools`; no API service-role key is introduced.
`/readyz/crm-mapping` must return
`{status:"ready",capability:"lifty-crm-mapping.v1"}` alongside the existing
`/readyz/crm` capability. Deployment smoke enforces both. This static probe
checks the installed RPC/version/key without reading tenant data, credentials
or HubSpot; it does not prove that the replay worker is deployed. Verify the
Jobs task version separately and use a disposable nonproduction exact-cohort
preview/replay/readback canary under the existing canary policy. Generic v5
clients consume these API-owned operations without a new CLI business registry.

## Staged Unipile V2 connections (LIF-916)

V2 is an additive, database-selected transport. Keep the V1 DSN, credentials,
namespace and hosted domain intact. Set `UNIPILE_V2_ACCESS_TOKEN` and
`UNIPILE_V2_APPLICATION_ID` together, with an application-scoped key. The API
uses `https://api.unipile.com/v2` for V2 only. Credentials alone do not select a
workspace or change an existing connection.

Apply the reviewed Functions LIF-916 migration and signed V2 lifecycle endpoint
before selecting pilot workspace/channel routing. The existing email/LinkedIn
RPCs return an immutable `transport` snapshot per intent and the active transport
per connection. Copied accounts preserve canonical V1 connection IDs, mailbox
budgets and LinkedIn history; provider calls use only the verified V2 alias.
Administrative prebinding must verify the provider's `metadata.v1_account_id`,
application, scope and owner against the existing canonical connection. New
V2-only accounts retain their real V2 ID and `unipile:v2:<application_id>`
namespace. They cannot be rolled back onto a fictitious V1 account.

`UNIPILE_V2_HOSTED_AUTH_ORIGINS` is a comma-separated allowlist of verified HTTPS
origins. The default `https://auth.unipile.com` is also allowed. Rollout configuration
snapshots the selected origin into each intent. The API passes that domain to
Unipile, checks the exact returned origin, and stores/redirects the returned URL
without rewriting it. Keep previous origins in the allowlist until their links
expire. Use a separate V2 domain while V1 links remain active; V1 URLs keep the
existing V1 browser-boundary rewrite.

The API first claims the intent, persists a channel-separated HMAC state, and
issues one hosted link. Browser return parameters never authorize attachment.
Only a separately authenticated, state-bearing lifecycle event can supply the
account for exact-attempt polling. Polling independently reads the account and
owner, checks application/scope/legacy alias, and submits verified evidence to
SQL. SQL rechecks ownership, current intent, expiry and disconnect races. V1
callbacks are rejected for V2 intents. Reconnection never enables sending.
LinkedIn health writes include transport version/generation to reject stale
readbacks after cutover or rollback.

Currently V2 accepts Google mailbox connections with exactly one verified primary
email sender, and LinkedIn with an exact self-profile match. Outlook and IMAP
continue on V1: the documented V2 account response does not expose the V1
delegated-mailbox flag or matching IMAP/SMTP service settings needed by the current
mailbox policy. V2 deliberately rejects those providers until equivalent vendor
evidence is established. This limitation does not change existing V1 Outlook or
IMAP support.

Rollback disables new V2 routing and uses the retained mapping's generation CAS
for copied accounts. Keep V2 credentials, endpoint and domains available while
V2 attempts or retained operations need reconciliation; do not erase mappings or
change the V1 namespace. Jobs must retain each operation's transport separately
so a successful or ambiguous send is never retried against the other version.

Local contract tests prove fail-closed API behavior, not vendor production
readiness. Release still requires independent review, actual signed webhook
validation, copied-account prebinding and a permitted live pilot. Sources:
[Hosted auth](https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth),
[provider features](https://developer.unipile.com/v2.0/docs/list-provider-features),
and the official [Unipile SDK](https://github.com/unipile/unipile-node) schemas at
`f839654cf7c8856635b9dae6032d00a91489560b`.
