# Campaigns

Purpose: configure the workspace journey once and activate automatic outreach
after one informed confirmation. `references.campaign` is the authoritative
setup context: read it for sequence, audience, personalization, cadence and
conversation behavior. Read `references.writing` before recommending or editing
copy. It supplies LIFT's writing defaults and the founder review process.
Read `references.common` for transport rules.

## Read current state

GET with empty query reads the current workspace sequence and its blockers.

## First setup

Before writing templates or calling prepare, follow the channel-choice and
sequence-explanation steps in `references.campaign`. Ask **LinkedIn, email,
both, or not right now** when the founder has not explicitly chosen, and wait.
Account availability is not channel intent; accepting leads is not a channel
choice. Keep disconnected channels available as connection options. Reuse a
choice already made. Explain the selected sequence and current/future audience
before asking for founder-written copy or permission to recommend templates.
Skipping keeps the lead-only path resumable without preparing or activating.

POST with `scope: "workspace"` and a prepare request saves the full recommended
configuration for the selected channels only: invitation plus three LinkedIn
messages and/or five emails. Never include a channel just because it is connected. Reuse saved targeting, commercial voice, sender and normal cadence.
Do not default to individual campaigns, choosing two Tier A sample leads or
asking for a date/time per recipient. Honor explicit audience/start overrides.

Show the complete returned preview, including sender, current and future
audience, templates, personalization and timing. The email branch follows the
existing journey: five business days without acceptance or the second confirmed
LinkedIn message; email-only configuration starts directly. Preparation never
sends. One explicit confirmation authorizes activation of the exact version and
digest. Read status afterward; activation is distinct from confirmed sending.
Material edits pause automatic outreach and require fresh confirmation.

## Later edits

Use workspace prepare to save a complete updated configuration, then show the
new preview before fresh confirmation. Use pause to stop automatic outreach.

### Existing individual campaigns

Only when explicitly requested, use the channel contracts for an individual
campaign or recovery. GET requires channel, workspace and campaign_ref; it is
not a campaign inventory. POST supports explicit lifecycle operations. Channel
PATCH only prepares an existing campaign. Follow `references.campaign` for the
channel-specific requirements and approval rules. Individual approval never
authorizes workspace-wide enrollment or future leads.

## User-facing behavior and errors

Explain actual returned blockers, preserve receipts after an uncertain write,
and read status before retrying. Sample acceptance and account connection never
authorize sending. Pending calibration or exhausted discovery allowance does
not prevent drafting from suitable saved leads. If workspace operations are
unavailable, retain the draft and state the limitation; do not silently fall
back to the old per-lead setup.
