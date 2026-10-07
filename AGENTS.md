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

The app name includes `staging`, but it uses shared GTM production Auth/database.
Juan's LIF-1097 decision on September 28, 2026 keeps connector rehearsal in this
environment; do not create another environment. Authenticated canaries require
an explicitly authorized internal workspace and seed data, and must stop before
live sending. Confirm the actual target and issue scope first. Public health
and fail-closed authentication smoke checks are safe.

## Installed clients and context

Every task context the agent reads comes from this API (`src/agent-context`),
so an API change ships its context change in the same PR and reaches every
founder on deploy. Do not change `STAGE_CLIENT_CONTRACT` for an API or
context release: it names the transport installed clients implement, and
changing it forces every founder to update the skill (LIF-1293). Keep
`tests/installed-client.test.ts` passing; a failure means the change breaks
installed clients. Change the contract only with a deliberate client release.

## Admin onboarding read

`GET /v1/admin/onboarding` (LIF-1297) lists every workspace through the
admin-only `admin_list_workspaces()` and computes each one's next_step with
the caller's own session, naming that workspace (`AuthSession.workspaceRef` →
`p_workspace_id`). Founder sessions never set it, so their reads are
unchanged. Its HubSpot, Attio and CRM sync reads need the Functions migration
`20261006200000_lif1297_admin_workspace_crm_reads.sql` first; deploy the
database through its production-database job before this API revision.
Identity reads forward the named workspace too; `get_lifty_senders` already
accepts it, so the Part 2 roster read (LIF-1302) needs no migration. Parts 3
and 4 (LIF-1260) read each mailbox's warmup and placement status and the
research schedule's plan; admins may read that status only after the Functions
migration `20261006220000_lif1260_admin_email_status.sql`, so deploy it first.
`NEXT_STEP_CATALOG` in `src/next-step.ts` is the step list the ops view shows,
and next_step builds each response's state, step, section, `context_task` and
`related_contexts` from it. Every stage context is linked by some step or
declared in `ON_REQUEST_CONTEXTS`; `tests/next-step-size.test.ts` enforces that
and that a step recommends only tools of the stages it links (LIF-1301).

## Context drafts

A LIFT admin can mark a workspace as a context test workspace in the ops
dashboard and save a draft of one `src/agent-context/<file>.md` for it
(LIF-1298). Drafts live in Supabase, written only by the admin RPCs of the
Functions migration `20261006210000_lif1298_context_drafts.sql`. lifty-api
reads them with the caller's own session (`get_lifty_context_drafts`) and
substitutes the published file only in authenticated responses: next_step
guides (CLI and MCP) and `/v1/context/<task>` when the request carries a
session, which the MCP adapter forwards. The installed CLI reads context
anonymously and always gets the git version. A served document lists its
`drafts` and gets its own revision. A failed read serves published context.
`GET /v1/admin/context` gives the ops editor every published file with its
SHA-256 and uses, plus the drafts and test workspaces. Promotion opens a
pull request here; `.github/workflows/verify.yml` runs `npm run verify` on it.
Each document's files are declared in `src/agent-context.ts`; key order is
part of the revision, so keep published documents byte-identical when
restructuring them.

## Connection confirmation

Browser integration callbacks use `src/connection-confirmation.ts` and its typed
flow inventory. Keep the document response independent of provider I/O; use the
bounded processing/status requests and durable attempt receipts. Unknown
outcomes stay pending and never replay OAuth codes or create another resource.
Every new browser callback must pass the shared conformance suite in `npm run
verify`. See LIF-1139 and the parent workspace's Connection confirmation contract.

LIF-1139 requires the Functions migration
`20260929203000_lif1139_connection_browser_receipts.sql` before this API revision.
HubSpot/Slack fail closed before exchanging a code if its claim RPC is unavailable.
Mailivery retains ephemeral tokens and its existing single-dispatch fence.

## Customer exclusion imports

LIF-1082's authenticated customer-exclusions status/import stage requires the
Functions migration `20261006180000_lif1082_founder_customer_exclusions.sql`
before this API revision. Deploy the database through its production-database
job first. The API reads and replaces founder-upload membership through member
RPCs; unavailable reads stay unknown. CRM and manual protections are preserved,
and a file containing only rejected customer rows cannot clear the saved list.

LIF-1128's explicit customer-source choice additionally requires
`20261008080000_lif1128_optional_customer_sources.sql`; activation/admission
holds require `20261008090000_lif1128_activation_hold.sql`. Pause the old Jobs
suppression nightly, catch-up and manual tasks and drain running syncs before
applying these migrations: the previous Jobs revision treats connection as
permission to read customers. Deploy the database through its required gates,
then the consent-aware Jobs revision and this API revision, before resuming
suppression tasks. Source choice is separate from connection and provider
grants; existing connections do not imply consent. Optional choice/status
reads that are unavailable stay unknown, and no release here bumps the
installed client contract.
