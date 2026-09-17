
# LIFTY workspace outreach configuration

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

## Default setup: one workspace sequence

This campaign context owns the setup policy. Read it through the campaigns
stage before proposing or changing outreach; do not substitute a locally
remembered campaign questionnaire. Use the current published operation schemas.

The founder flow is **choose channels → explain the sequence → choose copy
approach → prepare the workspace sequence → show its complete preview → one
informed confirmation → activate automatic outreach**. The
backend owns continued enrollment and execution after the conversation closes.
Account connection, sample acceptance and a saved draft never authorize sends.

1. Read the campaigns stage with empty query `{}` (workspace status is the
   default). Reuse saved targeting, commercial voice and verified sending
   accounts. Read their current stages if that information is missing or stale.
   Do not ask the founder to repeat saved business answers.
2. Establish the founder's outreach choice before writing templates or calling
   prepare. If no explicit choice exists, ask: **"Would you like to use LinkedIn,
   email, both, or not right now?"** Wait for the answer. A connected mailbox
   does not select email; disconnected LinkedIn remains an option to connect.
   "Looks good" after lead review accepts that sample only. A request to
   continue is not a channel choice. Reuse an explicit choice already made in
   this conversation or confirmed for the campaign being edited; do not ask again.
   If the founder skips, keep the lead-only path resumable and do not prepare
   or activate a campaign. Deferring new setup does not pause existing campaigns;
   a request to stop existing outreach follows the explicit pause workflow.
3. Before drafting, explain the selected sequence in plain language using the
   fixed journey below: steps, acceptance dependency, channel entry, follow-up
   delays and stop-on-reply. Mention the recommended audience of current and
   future eligible A/B leads; the five reviewed leads are a sample, not the
   default campaign limit. Use a verified count when available. Ask whether the
   founder wants to provide their own copy or have Lifty recommend it, and wait
   unless they already requested one approach. Channel/copy choices are setup
   decisions, not sending approval. Connect only selected missing accounts via
   their stage guidance; reuse healthy accounts. Resolve requested CRM activity
   logging through current supported operations before drafting, reporting any
   unsupported setting honestly. Do not silently drop a selected channel when
   its account is disconnected or blocked; explain and offer connection or an
   explicit change of choice.
4. Prepare a complete recommended configuration for only the selected channels using POST with
   `scope: "workspace"` and `request.operation: "prepare"`. The payload contains
   the current workspace and `configuration`: name, the selected LinkedIn
   account plus all three message templates and/or the selected email account
   plus all five email templates. Omit channels the founder did not select,
   even when their accounts are connected. Follow the published schema. Omit `lead_ids`
   for current and future eligible A/B leads. Omit `not_before` to use the normal
   cadence from activation. Drafting is possible without a new calibration run.
5. Show the returned full workspace preview: actual senders, audience rule
   (including future leads), complete templates, allowed personalization,
   current recipient examples, channel entry, cadence and stop rules. Explain
   real blockers, including `blocked_leads` and the total blocked count; never
   report those leads as scheduled. Missing placeholder data skips that recipient; it is never
   invented. Only `{{first_name}}`, `{{last_name}}` and `{{company_name}}` are
   permitted substitutions. Do not imply that approval covers arbitrary future
   model-generated copy.
6. Ask once for confirmation of that complete configuration and authorization
   to start automatic outreach. On confirmation, POST `scope: "workspace"`
   with `request.operation: "activate"`, the exact `version_ref`, `digest`,
   workspace and `confirm: true`. Read status afterward. Report activation only
   from the confirmed receipt, and distinguish activation from an actual send.
7. Later material edits use workspace prepare and a fresh preview/confirmation.
   They pause automatic outreach. The new version applies to newly enrolled
   leads; existing journeys retain their approved copy, sender and cadence.
   Show `continuing_versions` and each recipient example’s `version_ref` in the
   preview so this is explicit. A narrowed audience also fences excluded leads.
   Explicit pause uses the current version and digest. Retain receipts and read status after uncertain writes before retrying.

The fixed journey is an invitation without a note, then three LinkedIn messages
only after confirmed acceptance. The second message waits four business days
from the first confirmed send; the third waits five more business days. When
both channels are selected, the five-email sequence enters after five business days
without LinkedIn acceptance, or after the second LinkedIn message is confirmed
sent. With email-only selected, email enters directly. Email follow-ups wait
3, 4, 4 and 4 days from their preceding confirmed sends. Sender working windows,
health, pacing and shared account limits still apply. Replies, suppression and
other terminal stops cancel remaining outreach across channels: 3/5 are planned
lengths, not promises to send despite a response.

Do not default to choosing “the two Tier A leads or all five accepted leads”,
preparing one opening email per person, or asking for a Thursday date/time.
Prepare the workspace recommendation from the saved settings. A founder who
explicitly asks for two named leads gets a narrowed `lead_ids` audience; an
explicit custom start uses `not_before`. Those are optional overrides, not
required setup questions. Ask only for a genuinely missing business input or
required account declaration. A pending/stale sample, fewer than five leads,
no Tier A leads, exhausted discovery allowance or an unconnected CRM does not
block connection or drafting. Preserve grades and reuse saved fit evidence;
never claim it was freshly researched. Activation still respects real account,
audience and approval blockers.

If the current API does not publish workspace operations or cannot verify their
result, retain a clearly labeled draft and explain that automatic workspace
activation is unavailable. Do not fall back to silently creating individual
campaigns or claim a graph/flag change enables execution.

## Explicit individual campaign operations

The channel operations below support explicitly requested individual work and
recovery of existing campaign references. They are not the default onboarding
setup. GET with `channel`, `workspace`, `campaign_ref` and optional
`operation: "preview" | "status"` reads one known campaign, not an inventory.
POST uses `{ "channel": "email" | "linkedin", "request": { "operation":
"<supported-operation>", "payload": { ... } } }`. PATCH supports preparation
with an existing campaign reference. Use JSON stdin (or a private mode-0600
file). Operation names belong in the request, never in the CLI verb position.

Individual consent covers only its exact preview; it does not grant workspace
consent or permission to enroll future leads. Changed sender, recipients, copy
or timing requires fresh approval. Keep provider and recipient pins, account
limits and stop-on-reply. Report outcomes in the founder's language and keep
paths and raw JSON private. An old runner without `stage` needs an installation
update; current v5 operation/schema changes come from refreshed API context.

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
   Historical `text` campaigns contain one post-acceptance message. New
   `messages` campaigns contain all three, with the returned fixed cadence;
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
