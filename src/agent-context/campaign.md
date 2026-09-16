
# LIFTY campaign operations

## Authorization links

Use the installed authorization guide for login and the common browser handoff.
For account setup, read the current `sending-accounts`, `crm`, or `notifications`
stage context and use its published operations through `lifty stage`. The stage
POST returns a real link immediately with an `attempt_ref` and expiry. Show that
link, let the founder choose their browser/account, and wait for their response.
Then read the same stage with the retained `attempt_ref` (and sending channel).
Only the matching verified completion confirms that authorization. An older
healthy grant does not complete a new reconnect, and a failed verification read
must preserve the reference for retry. See the stage's connection guidance for
pending, expiry, denial and failure. Never open the browser automatically or
activate sending as part of connection setup.

Login keeps its existing short-lived callback listener alive until completion,
cancellation or expiry; provider-stage authorization requires an existing Lifty
session and does not replace that listener.

Use `<installed-runner>` verified by the installed entry skill's runner
resolver, for either project or global scope. The active project owns private
artifacts; it does not determine the runner's location. Refresh the stage index
and campaigns contract before working:

```text
node "<installed-runner>" context stages
node "<installed-runner>" context campaigns
node "<installed-runner>" stage campaigns get --input -
node "<installed-runner>" stage campaigns post --input -
node "<installed-runner>" stage campaigns patch --input -
```

Read current `operations` schemas and use JSON stdin (or a private mode-0600
file). GET takes `{ "query": { "channel": "email" | "linkedin",
"workspace": "<current-workspace>", "campaign_ref": "<saved-reference>",
"operation": "preview" | "status" } }`. There is no campaign inventory read;
retain the references from real receipts. POST takes `{ "body": { "channel":
"email" | "linkedin", "request": { "operation": "<supported-operation>",
"payload": { ... } } } }`. Payload contains the workspace and other inputs
required by that operation's fresh channel schema. PATCH has the same envelope
but supports only `prepare` with an existing campaign_ref. Do not invent a
status-setting PATCH or put campaign operation names in the CLI verb position.

The channel steps below select the nested request operation; all use this
stage transport. Use GET for preview/status, POST for supported operational
commands and initial preparation, and PATCH for an existing draft's preparation.
An old runner without `stage` needs an installation update first; API validation
or field/route changes require fresh context and correction, not a CLI rebuild.
Report outcomes in the founder's language, keeping paths and raw JSON private.

## Handoff from targeting review

When the founder asks to continue outreach setup, proceed with their chosen
channel and collect only its missing account declarations. Follow
`references.calibration` for lead-quality feedback, but a pending or stale
sample, fewer than five leads, no Tier A leads, exhausted discovery allowance,
or an unconnected CRM does not block account connection or message drafting.
Setup and calibration have separate progress; report both honestly.

The founder may explicitly choose Tier B recipients. Inspect saved evidence
against the current targeting, preserve recorded grades, and identify the exact
intended recipients. An ICP update invalidates the old sample's acceptance,
not every account connection or usable fact about every existing lead. Reuse
evidence when it supports current fit; do not acquire a new cohort merely to
continue setup or claim an old grade was freshly produced by Scout.

Without a recipient or a healthy account, help choose channel, sender, copy
and timing and retain a clearly labeled draft. Call campaign prepare/preview
only when their real required inputs exist; do not invent lead references or
claim a local draft is a saved campaign. Missing prerequisites block their
dependent operation, not all setup. Before activation, resolve actual
recipient/account/preview blockers and obtain explicit approval of the exact
preview and authorization to send. Choosing B leads or connecting an account
does not by itself grant that approval. No five-lead or Tier-A-only gate is
added to the campaign workflow.

## Email campaigns

If no eligible email account is connected, offer the hosted email connection
from the `sending-accounts` stage. Start it with the published email input;
provider/account selection and the habitual personal-mailbox declaration happen
in the browser. Do not ask for an address or mailbox-use questionnaire first.
Reconnection creates a separately verifiable attempt while the existing grant
remains usable; it does not require a destructive disconnect. A replacement
account still follows the provider's existing pinned-account policy. Verify the
exact returned attempt after the founder finishes. Connection never activates
sending. The habitual-use beta supports existing correspondence mailboxes and
blocks new/dedicated outreach mailboxes; read current preview policy and blockers
before preparing or approving a send.

Use this path only when the founder asks to prepare or operate a campaign.
Connecting email never approves a campaign or activates sending. Resolve the
workspace explicitly and preserve the recipient and campaign references the
CLI returns; never substitute another workspace or provider silently.

1. Use email POST operation `target` to import the intended recipient, using
   the current schema for their address and optional names. Repeating the exact
   email reuses its workspace lead. Retain the returned lead reference.
2. If provider selection is needed, email POST operation `provider` selects it
   for new executions. Follow the current channel/provider schema. Selection
   alone does not demonstrate transport support or enable sending. Existing
   executions keep their pinned provider and account.
3. Use `prepare` with the intended lead, current sender connection, name, start
   time and supported steps from the live schema. Obtain connection_ref from
   the sending-accounts email GET. Follow-ups wait at least one minute after
   the previous confirmed send. Use PATCH with the saved campaign_ref for edits.
   A retry of identical content reuses its version; material edits invalidate
   approval and cancel outstanding steps of the old version.
4. GET the exact preview. Show sender, recipient, copy, schedule, daily ceiling
   and blockers. Do not fabricate warmup or placement evidence. Habitual personal
   or business correspondence accounts may qualify, including corporate domains;
   new/dedicated outreach accounts are blocked. Explain that managed warmup is
   unavailable and offer a suitable account through the approved connection
   workflow. Never disconnect an account without explicit authorization.
   For `lifty.personal-beta.v1`, placement is neither required nor performed:
   do not request tests, confirm seeds or fabricate a passed result. Review the
   actual policy, blockers and digest. A policy/content change requires a new
   preview and explicit approval; strict-policy workspaces retain their gates.
5. After explicit approval of the exact preview, POST `approve` with that
   campaign reference, workspace and digest. POST `activate` only when sending
   is separately authorized. A stale digest requires a fresh preview/approval;
   never silently approve changed content or write database evidence manually.
6. GET status for actual step states and ingested replies. A confirmed reply
   cancels pending follow-ups; read back cancellation instead of inferring it
   from a send 2xx. An unconfirmed send or accepted email lacking a linked
   receipt keeps its mailbox budget consumed and dependent steps blocked.
   Do not resend or promise automatic recovery. If the founder authorizes
   stopping future steps permanently, POST `cancel` with the exact digest and
   current schema's cancellation confirmation. GET the canceled state.
   Cancellation retains receipts and budget and cannot recall accepted mail.
7. POST `pause` stops future steps. POST `suppress` suppresses the intended
   recipient. To disconnect email after explicit authorization, use the existing
   `disconnect unipile --workspace <workspace>` command; no stage operation
   replaces that destructive action. Reconnection neither restarts campaigns
   nor clears the physical mailbox's daily count.

LIFTY enforces at most ten automated emails per physical mailbox per UTC day,
including supported placement and sequence sends, across workspaces, provider
changes and reconnections. Unknown send outcomes remain counted. Do not reset
counters or send extra real emails to test the cap. Never claim email testing
validates LinkedIn. After timeouts preserve the exact request and references, then GET status
before deciding whether any retry is safe. Do not replay uncertain sends.

## LinkedIn campaigns

Use this separate channel path when the founder asks for LinkedIn outreach.
The beta supports one existing habitual-use account per workspace. Read the
`sending-accounts` stage and obtain the founder's IANA timezone plus explicit
personal-use and no-other-automation declarations required by its LinkedIn POST.
If another automation tool is active, do not connect. Hand off the returned real
link and verify the same attempt after the founder finishes. Credentials stay
in the hosted browser flow. A normal stage GET without `attempt_ref` reads the
current connection reference and health for campaign preparation; it is not
proof of a new authorization. Connection does not authorize or activate sends.

1. Select an existing researched lead in this workspace with its stored
   LinkedIn profile. Never guess an ID or replace the recipient silently.
   Use LinkedIn POST `prepare` with the current schema's lead, connection and
   plain-text message fields. Text is nonempty and at most 3,000 characters.
   Use PATCH `prepare` with campaign_ref for edits. Invitation notes and
   follow-up fields are unsupported.
2. GET preview. Show the exact recipient, sender account, message and schedule.
   The sequence is an invitation without a note and one message after acceptance;
   subsequent conversation is manual. Limits remain five invitations per day,
   25 per rolling seven days and five messages per day, Monday–Friday 09:00–17:00
   in the account timezone, 15–45 minutes apart. Read the actual preview and
   blockers; never edit limits to bypass them.
3. After exact preview approval, POST `approve` with the reference, workspace,
   digest and confirmation required by the fresh schema. POST `activate` only
   when sending is authorized. Changed copy or a stale digest requires a new
   preview/approval; connection never supplies activation permission.
4. GET status to report receipts, acceptance and blockers. An inbound reply
   before the first message prevents it. Replies stop pending outreach on both
   channels. Invitation acceptance or an uncertain response is not a sent
   message. Preserve references and inspect status for ambiguous actions; do
   not resend or create duplicate campaigns. Acceptance detection may arrive later.
5. POST `pause` or, after authorization, `cancel` with the digest and explicit
   confirmation required by the current LinkedIn schema. GET the resulting
   state. Neither action recalls a previously accepted send.
6. Checkpoint, credential and restriction incidents pause sending. Resolve the
   account issue before an explicitly requested sending-accounts reconnect.
   Reconnection preserves history/consumed limits and never restarts campaigns;
   reactivation is explicit. Authorized disconnection still uses
   `disconnect linkedin --workspace <workspace-ref>`.

Canonical lead activity records continue to show invitations, acceptance,
messages and replies through Unipile. Preserve those receipts when describing
history. No warmup period or elapsed warning-free interval substitutes for
functional canary acceptance, and the skill must not send extra test actions
without approval of the exact recipient, account and copy.

## Hard stops

- Never activate without authorization for the exact recipient, sender, copy
  and schedule. Preparation, preview, approval and activation stay separate.
- Never request, print or summarize tokens, keys, callback payloads or credentials.
- Never disconnect without the founder's explicit yes in this conversation.
- Configuration changes use the relevant stage's PATCH and generated-artifact
  workflow. Do not repeat first onboarding for an already-configured workspace.
- Multi-lane and protected-prompt restrictions stay in force; do not combine
  lanes, replace hand-tuned prompts or route around a rejection.

Before new discovery, GET capacity for actual used/reserved/remaining slots and
its reset time. Exhaustion does not prevent account setup, saved-lead review or
drafting; never bypass reservations through retries, dry runs or manual inserts.
