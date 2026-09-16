# LIF-627/628 isolation verification

The session fence requires the database migration
`20260916111819_lif627_active_session_fence.sql` before this API release.
Every protected REST request validates signature, expiry, issuer, audience and
role, then checks the caller's active Auth session with its own JWT. The same
session predicate runs as PostgREST's pre-request hook, covering direct Data API
calls and rechecking authorization before each database operation. An expired,
revoked, foreign, missing or malformed session, a deleted/banned user, or an
unavailable upstream returns the generic `invalid_session` result. Affirmative
session checks are not cached. This adds one bounded RPC per REST request.

The migration preserves the existing anonymous capability and backend contracts.
It refuses to replace a different pre-request hook. It grants no Auth table
access to founders and exposes only the current session's boolean status.
A read-only preflight confirmed the existing database owner can read the two
Auth tables and no authenticator pre-request hook was already configured in GTM.

## Reproduce the local evidence

Use the matching Functions branch containing the migration and
`scripts/replay-isolation-migrations.py`. Docker and the pinned Supabase/Node
images are required. Run from this API checkout after `npm ci`:

```sh
npm run verify
node scripts/isolation-fixture.mjs start /absolute/path/to/functions /absolute/path/to/new-evidence
node scripts/test-isolation-local.mjs /absolute/path/to/new-evidence/canary.json
node scripts/isolation-fixture.mjs stop
```

The bootstrap refuses existing fixture resources, labels its own containers,
uses an internal-only network, disables external cron execution and performs a
complete source migration replay. It initializes real GoTrue **before** replay:
the raw PostgreSQL image has an older Auth schema and its initial `auth.uid()`
does not read JSON JWT claims. The fixture clears historical provider approvals
at the same boundary as source CI; it fabricates no provider warmup observations.
No published host ports or real providers are used. `stop` removes only resources
owned by that bootstrap; the shared development stack remains untouched.

The canary uses real GoTrue signup/login/logout and PostgREST HTTP requests. REST
handlers run through Hono's Request interface in the same process as the test.
A temporary Node transport bridges the internal network and is removed afterward.
Only synthetic users/workspaces/credentials exist in that database. The fixture
is disposable; remove it even after a failed assertion.

Coverage includes two separate founders, workspace creation/retry, own/foreign
workspace/membership/lead/campaign reads, feedback CRUD/upsert with privileged
invariant readback, the permitted integration metadata columns, denied credential
pointer/plaintext access, the approved Vault resolver and private audit trail,
concurrent onboarding retries, foreign context, a failed queue after receipt
creation, exact worker import and completed retry, invalid/expired/backend JWT
rejection at user routes, membership removal, real global logout and error/log
redaction. The unit route matrix also exercises all 41 documented protected
operations with missing, malformed and expired JWTs before upstream work.

The receipt contains assertions, environment, source identity and explicit
limitations. It excludes tokens, passwords, provider bodies, drafts and decrypted
secrets. A successful fixture receipt always has `production_acceptance: false`.
It proves neither the deployed catalog nor every public object's positive
behavior. Realtime revocation, external provider lifecycles, remaining object
fixtures and the real deployed canary are still separate acceptance gates.

## Release and rollback boundary

1. Review both branches and require their normal CI, catalog manifest and SQL
   contracts. The local PostgreSQL 17.6 ARM build crashes in the existing LIF-620
   final pgTAP denied-definer probe; its preceding nine catalog assertions pass.
   This is recorded as incomplete local verification, not a passing whole suite.
   The HTTP canary proves denied secret resolution without that pgTAP wrapper.
2. Reconcile the documented source/live catalog differences under LIF-627. The
   source inventory is not an approved production baseline. Capture both sides
   with format 2, including roles, memberships, defaults, indexes and ledger.
3. Apply reviewed database changes first, verify a real valid user and a revoked
   session through Data API, then deploy the API. Deploying this API without its
   session RPC deliberately fails closed for authenticated requests.
4. Run the deployed two-founder matrix against the identified GTM environment,
   bind its receipt to exact database/API commits and deployed migration versions,
   and publish that receipt to the linked launch issues before claiming acceptance.

No production change or authenticated production canary is performed by these
scripts. Push, PR, merge and release actions follow the workspace authorization
rules. The older API AGENTS instruction about a separate non-production Supabase
must be reconciled with the explicit Linear decision that the real launch target
is shared GTM; the app name `staging` is not environment isolation evidence.

For an API-only rollback, restore the previous reviewed API release while keeping
the database fence. Removing the database fence needs a separately reviewed
recovery plan: simply disabling it restores the revoked-JWT exposure. Do not
relax grants, RLS or the session predicate to make a test pass.
