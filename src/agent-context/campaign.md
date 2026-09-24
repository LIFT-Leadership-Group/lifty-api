

Before proposing setup or changes in a new authenticated session, read `summary.get`
using `context summary`. Reuse verified saved state. Read business before asking
for a website, sending-accounts before reconnecting, and campaigns before configuring
outreach. Unavailable reads require a retry, not assumptions that setup is missing.
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

## Default setup: one persistent shared-engine campaign

New campaigns use `engine: "shared_v1"` through workspace `configure` and
`modify`. The graph, composition modes and outreach overlays are existing shared
engine capabilities. Lifty configures that engine and reads its saved state.
The graph determines channel entry, message count, conditions, delays and end;
do not substitute a fixed three-message journey or one campaign per sample lead.

The campaign covers **current and future eligible A/B leads** by default.
Calibration is a sample for learning and reviewing examples, not a recipient
list. Omit `lead_ids` unless the founder explicitly limits the audience. A
language or tone request belongs in the ordinary outreach overlay when needed;
it does not require a new language setting, a country field, or a campaign per
recipient. Ground generated copy in the actual evidence available for each lead.

The founder flow is **read saved state → choose channels and journey → configure
composition → read ready preview → one informed confirmation → activate**.
The backend enrolls future eligible leads and executes after the chat closes.
Account connection, sample acceptance and a saved draft never authorize sends.

## Read before configuring or editing

GET the campaigns stage with empty query `{}`. Read the saved configuration,
version_ref, digest, preparation, blockers, continuing_versions and previews.
Reuse the business, targeting, commercial voice and sending-account stages when
needed. Unavailable reads require retry; they do not mean setup is missing.

If channel choice is missing, offer **LinkedIn, email, both, or not right now**
and wait. Reuse an explicit choice; a connected account does not choose its
channel. Keep disconnected channels available as connection options. Explain
the requested journey, current/future audience and stop-on-reply before writing
copy. Ask only for missing intent or required account declarations. Pending
calibration or exhausted discovery allowance does not prevent drafting.

## Composition and outreach overlay

Read `references.writing` and `references.anti_slop`. Preserve the founder's
chosen purpose, voice and previously approved content.

- `compose_mode: "generate"` uses the shared outreach compositor for each lead.
  `overlay` stores reusable instructions such as the purpose of each graph step,
  voice, factual constraints and founder preferences. It may be empty to use
  shared defaults. Do not supply fixed `messages` or `steps` text arrays or a
  `template_bank` in generated mode.
- `compose_mode: "templates"` uses the existing channel template-bank mechanism.
  `template_bank`, when supplied, is the existing Markdown bank, not a new array
  of three texts. Existing shared defaults may supply a bank when omitted;
  preparation reports missing or invalid templates. Read the saved bank before
  modifying it. Generated mode and templates are distinct supported choices.
- This `overlay` is the campaign's **outreach** overlay. The generated onboarding
  configuration and Scout research overlay configure discovery/research; they
  do not configure outreach copy. Use campaign operations for outreach changes.

An overlay should work for future recipients. Sample-specific observations are
review examples, not universal claims to paste into every message. The shared
compositor uses the approved policy and the lead's evidence, then persists the
resulting copy. Retrying and preview reads reuse saved copy.

## Existing template-bank format

For a one-greeting LinkedIn graph, a complete minimal template_bank string is
this Markdown. Keep its marker, Fit/Slots guidance and fenced text intact:

````markdown
<!-- template: id=hello channel=linkedin case=first_dm arm=pain coverage=broad -->
Fit: A short greeting for an eligible lead.
Slots: {first_name} = the lead's given name.
```text
Hi {first_name}, glad to connect.
```
````

Each template ID is unique. Keep at least one broad opener. Later LinkedIn slots
use case linkedin_followup, touch 3 for the second message and touch 4 for the
third. Creative slots need explicit Slots guidance; trusted sender/lead slots
remain scoped to saved data. The template bank count must cover the graph.
Email banks declare `<!-- email-bank: sequence_steps=4 -->` or 5, a Subject line,
and a template marker per step such as
`<!-- template: id=hello-email channel=email step=1 arm=direct variant=intro coverage=broad -->`.
Steps 2..4 or 2..5 retain a coherent arm/variant route. Follow the same Fit,
Slots and fenced-text format. Preparation rejects malformed/incomplete banks;
it never guesses missing steps or approves a client-placeholder skeleton.

## Configure, preview, activate

POST `{ "scope": "workspace", "request": { "operation": "configure",
"payload": { ... } } }` with workspace and configuration. Initial configuration
omits version_ref/digest. Replacing an existing configuration requires **both**
references from its latest read; stale identity is rejected. Configuration
includes name, engine, graph, selected channel connection_ref/compose_mode/overlay,
optional template_bank and optional delivery_specs. Omit unselected channels.
Omit not_before for normal timing from activation.

Configuration saves an inactive version. `preparation.state: "pending"` means
the backend still has to validate the graph and pin shared composition context
and examples. Read GET again; do not activate while pending. `failed` includes
errors to resolve through an edit. A ready preparation does not by itself mean
sending prerequisites or approval are satisfied. Show actual blockers and
blocked_leads, and preserve receipts after uncertain writes before retrying.

Show the **saved definition** (graph, composition policy, sender, current/future
audience, timing and stop rules) together with the **saved recipient examples**
from previews. Preview examples do not restrict the audience. In generated mode,
the founder can approve the reusable generation policy for future eligible leads;
do not impose individual review of every future lead as a universal rule. The
approval binds this exact configuration and its pinned composition context.

After one explicit confirmation of the complete ready preview and authorization
to start automatic outreach, POST `activate` with workspace, exact version_ref,
digest and `confirm: true`. Read status afterward. Distinguish activation from
confirmed invitation/message receipts. Sending still respects account health,
working windows, pacing, caps, suppression and replies.

## Supported graph contract

Use the published JSON schema and the existing compiled format
`journey_graph.v1.1`. Blocks have key/kind and optional label/channel/provider/
action/delivery_spec_key/terminal_reason. Transitions have key/branch_key/from/to
and trigger. Triggers are start, event, or time with after and anchor. Delays use
`{ "business_days": N }` or `{ "days": N }`; sending timers must anchor to
`action_completed`, so a hold or unsent action cannot start the next delay.
`fork` allows a branch, and `close: "branch" | "journey"` belongs on end edges.
Preparation validates supported execution semantics; structural acceptance alone
is not proof an arbitrary action is executable.

The current Lifty adapters execute these shared graph blocks:

- `start`: kind start, channel system.
- `send_connection_request`: provider_action, channel linkedin, provider unipile,
  action connection_request; the invitation has no note.
- `send_first_linkedin_message`, `send_second_linkedin_message`,
  `send_third_linkedin_message`: provider_action, channel linkedin, provider
  unipile, action linkedin_message. Include only the contiguous slots needed:
  one, two or three. The first waits for linkedin_connection_request_accepted;
  follow-ups and completion wait for the preceding confirmed action. One greeting
  after acceptance is a valid journey. Do not add later messages automatically.
- `email_sequence`: provider_campaign, channel email, provider unipile, with a
  delivery_spec_key referencing configuration.delivery_specs. The graph controls
  email entry and completion; the declared spec controls internal email timing.
  Its steps use seq_number 1..4 or 1..5 and delay_in_days: first 0, later 1..30.
  Completion uses the existing email_sequence_completed event.
- End nodes such as sequence_complete, replied and no_connection use kind end
  and channel system. Only supported terminal behavior is accepted.

Retain stop_policies for reply/meeting_booked with complete_journey, suppression
with suppress_journey, and manual_stop with manual_stop_journey, all scoped to
journey. These stops fence pending actions across channels. The backend rejects
unsupported providers/actions, cycles, acceptance bypass and premature completion.
Do not promise manual/decision blocks or arbitrary providers merely because the
shared parser knows their structural kinds. Omit event_policies or use an empty
array: Lifty does not execute arbitrary event-policy actions such as notify or
crm_update from graph metadata. For an email graph, preserve the event_registry
alias email_sequence_completed: ["lifty_email_sequence_completed"].

## Example: invitation, acceptance, one generated greeting, end

Replace the example workspace/connection UUIDs with references from authenticated
reads. Feed this body to `stage campaigns post --input -` using JSON stdin. It
has no recipient list, so future eligible A/B leads are included.

```json
{
  "scope": "workspace",
  "request": {
    "operation": "configure",
    "payload": {
      "workspace": "22222222-2222-4222-8222-222222222222",
      "configuration": {
        "engine": "shared_v1",
        "name": "A greeting after acceptance",
        "linkedin": {
          "connection_ref": "33333333-3333-4333-8333-333333333333",
          "compose_mode": "generate",
          "overlay": "Write a brief greeting after acceptance from the saved sender. Follow the saved commercial voice and use only supported lead facts. No pitch, question or meeting request."
        },
        "graph": {
          "schema_version": "journey_graph.v1.1",
          "blocks": [
            { "key": "start", "kind": "start", "channel": "system" },
            { "key": "send_connection_request", "kind": "provider_action", "channel": "linkedin", "provider": "unipile", "action": "connection_request" },
            { "key": "send_first_linkedin_message", "kind": "provider_action", "channel": "linkedin", "provider": "unipile", "action": "linkedin_message" },
            { "key": "sequence_complete", "kind": "end", "channel": "system", "terminal_reason": "no_reply" }
          ],
          "transitions": [
            { "key": "invite", "branch_key": "outreach", "from": "start", "to": "send_connection_request", "trigger": { "type": "start" } },
            { "key": "accepted", "branch_key": "outreach", "from": "send_connection_request", "to": "send_first_linkedin_message", "trigger": { "type": "event", "event": "linkedin_connection_request_accepted" } },
            { "key": "finished", "branch_key": "outreach", "from": "send_first_linkedin_message", "to": "sequence_complete", "trigger": { "type": "time", "after": { "business_days": 0 }, "anchor": "action_completed" } }
          ],
          "stop_policies": [
            { "event": "reply", "scope": "journey", "action": "complete_journey" },
            { "event": "meeting_booked", "scope": "journey", "action": "complete_journey" },
            { "event": "suppression", "scope": "journey", "action": "suppress_journey" },
            { "event": "manual_stop", "scope": "journey", "action": "manual_stop_journey" }
          ]
        }
      }
    }
  }
}
```

## Modify only what the founder changes

Read first, then PATCH with operation modify and current version_ref/digest.
Use changes for only the requested fields. Omitted fields remain saved; nested
channel fields merge. Arrays and supplied graph/delivery_specs replace their
whole previous value. Null removes a channel, clears lead_ids back to the
current/future audience, clears not_before, or removes template_bank. To switch
from templates to generate, send compose_mode generate and template_bank null.
Do not copy sample IDs into lead_ids while changing an overlay.

This example changes only the LinkedIn overlay. Replace both version references
with the latest saved values and feed it to `stage campaigns patch --input -`.

```json
{
  "scope": "workspace",
  "request": {
    "operation": "modify",
    "payload": {
      "workspace": "22222222-2222-4222-8222-222222222222",
      "version_ref": "44444444-4444-4444-8444-444444444444",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "changes": {
        "linkedin": { "overlay": "Keep the greeting to one short sentence in the saved sender's voice, without a pitch or question." }
      }
    }
  }
}
```

To change a follow-up from four to two business days, copy the graph from GET,
find the transition from send_first_linkedin_message to
send_second_linkedin_message, change only trigger.after to
`{ "business_days": 2 }`, retain trigger.anchor action_completed, and submit
that full graph in changes.graph. Preserve every other edge, channel, mode,
overlay and audience setting. A graph without that follow-up should not acquire
it from a timing edit. Read the resulting configuration and verify the requested
change and preserved values.

For that timing edit, save the GET response privately as saved-campaign.json.
This complete timing-edit.mjs script creates the PATCH body from the saved
receipt and fails if the requested follow-up does not exist:

```javascript
import { readFileSync } from "node:fs";
const saved = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (saved.configuration?.engine !== "shared_v1" || !saved.version_ref || !saved.digest) {
  throw new Error("Read the current shared campaign first.");
}
const graph = structuredClone(saved.configuration.graph);
const matches = graph.transitions.filter(edge =>
  edge.from === "send_first_linkedin_message" && edge.to === "send_second_linkedin_message");
if (matches.length !== 1 || matches[0].trigger.type !== "time" ||
    matches[0].trigger.anchor !== "action_completed") {
  throw new Error("This campaign does not have that timed follow-up.");
}
matches[0].trigger.after = { business_days: 2 };
process.stdout.write(JSON.stringify({ scope: "workspace", request: {
  operation: "modify", payload: { workspace: saved.workspace_ref,
    version_ref: saved.version_ref, digest: saved.digest, changes: { graph } }
} }));
```

Use `umask 077`, then `node timing-edit.mjs saved-campaign.json > timing-edit.json`.
Submit with `node "<installed-runner>" stage campaigns patch --input timing-edit.json`.
An old saved receipt will be rejected as stale; read again rather than replacing
its version references with guessed values.

Material edits pause automatic outreach and require new preparation and explicit
activation. Existing enrolled journeys retain their approved version; show
continuing_versions and each preview's version_ref. Do not claim an edit rewrote
those journeys. An unchanged edit may return the same version. Pause explicitly
with the current version/digest and confirm true when asked to stop outreach.

## Existing campaigns and unavailable operations

Existing fixed workspace campaigns remain readable, pausable and activatable
with their original contract. `prepare` is the legacy full-text compatibility
operation; it requires the old three LinkedIn/five email text arrays. That is
not the shared engine's minimum and not the default for new setup. Migrating a
legacy workspace definition uses configure with its current version/digest and
a complete shared definition after explaining the change.

Existing individual drafts and enrollments retain their references. Do not
silently replace them or create duplicates. Explain returned conflicts instead
of treating per-lead drafts as the automatic onboarding solution. If the API
cannot verify workspace configuration, retain the draft and describe the actual
blocker; do not fall back to per-lead campaigns. No setup operation sends.

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
provider/account selection and the mailbox-use declaration happen
in the browser. Do not ask for an address or mailbox-use questionnaire first.
Reconnection creates a separately verifiable attempt while the existing grant
remains usable; it does not require a destructive disconnect. A replacement
account still follows the provider's existing pinned-account policy. Verify the
exact returned attempt after the founder finishes. Connection never activates
sending. The hosted form asks whether the account is a mailbox the founder
already uses (`personal`, the default) or a new or dedicated account for
outreach (`outreach`). Once the connection is verified, offer warmup as the
`sending-accounts` stage describes. Read current preview policy and blockers
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
   or business correspondence accounts may qualify, including corporate domains.
   A new or dedicated `outreach` account shows `email_warmup_required` until
   its warmup passes: 21 active days, healthy, checked within the last 24 hours.
   Read `lifty email warmup status --workspace <workspace>` and give the
   founder its `recommended_go_live` date and message. Never promise an earlier
   date. The founder can still prepare and approve the preview; activation
   stays blocked until outreach unlocks. Never disconnect an account without
   explicit authorization.
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

Use this separate channel path only for explicitly requested individual LinkedIn
work or recovery. New workspace outreach uses shared configure above.
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

- Never activate without authorization for the exact campaign definition and
  sender: graph, audience, composition policy and timing for shared campaigns;
  exact recipient/copy for individual campaigns. Preparation never sends.
- Never request, print or summarize tokens, keys, callback payloads or credentials.
- Never disconnect without the founder's explicit yes in this conversation.
- Configuration changes use the relevant stage's PATCH and generated-artifact
  workflow where that stage requires one. Campaign graph/mode/overlay edits use
  campaign modify. Do not repeat first onboarding for an already-configured workspace.
- Multi-lane and protected-prompt restrictions stay in force; do not combine
  lanes, replace hand-tuned prompts or route around a rejection.

Before new discovery, GET capacity for actual used/reserved/remaining slots and
its reset time. Exhaustion does not prevent account setup, saved-lead review or
drafting; never bypass reservations through retries, dry runs or manual inserts.
