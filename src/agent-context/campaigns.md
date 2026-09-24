# Campaigns

Purpose: configure a persistent campaign using the existing shared engine's
graph, compose modes and outreach overlays. New campaigns use shared_v1.
Read references.campaign for supported actions, schemas, runnable examples,
composition, preview and approval. Read references.writing and
references.anti_slop before recommending copy; references.common owns transport.

## Read current state

GET with empty query reads the saved workspace configuration, version_ref,
digest, preparation state, blockers and saved recipient examples. Read before
creating or modifying. A failed read is unavailable, not missing setup.
The campaign includes current and future eligible A/B leads unless the founder
explicitly narrows lead_ids. Calibration leads are examples, not the audience.

## First setup

Reuse the founder's explicit channel choice. If missing, offer LinkedIn, email,
both, or not right now and wait. Connection and sample acceptance are not channel
intent. Explain the chosen journey and future audience before drafting.

POST scope workspace, operation configure saves engine shared_v1, name, graph
and selected channels with connection_ref, compose_mode and overlay. Generate
composes for each lead using reusable outreach instructions; templates uses the
existing Markdown template bank. This outreach overlay is separate from Scout.
Do not add a country field or a separate language configuration. Do not require
fixed message arrays in generate mode. The graph defines steps, waits and end;
one invitation without a note, acceptance, one greeting and end is supported.
Do not create a campaign per calibration lead or impose three messages.

Omit lead_ids for current and future eligible leads. Omit not_before for normal
timing. Initial configure omits version_ref/digest; replacement requires both
from a fresh read. Configuration does not send. Preparation pending means wait
and read again; failed includes errors; ready still requires resolved blockers
and founder approval. Show the saved graph, composition policy, sender, audience,
timing and saved examples. Examples are not the full future recipient list.
The founder can approve a generation policy for future leads. After explicit
confirmation, activate the exact version_ref/digest with confirm true, then read
status. Activation and actual sending are different facts.

## Later edits

Read first. PATCH scope workspace, operation modify with current version_ref,
digest and only changes requested. Nested channel fields merge; arrays and graph
replace. Omitted fields stay saved. Null removes a channel, lead_ids override,
not_before override or template_bank. Switching templates to generate clears
template_bank with null. A timing edit copies the saved graph and changes only
the relevant transition, preserving the rest. Stale references require a read.
Read back the result; do not rewrite unrelated graph, channels, mode or overlay.

Material edits pause automatic outreach and need fresh preparation and approval.
Continuing_versions identifies enrolled leads on earlier approved definitions.
Use pause with current version/digest when asked to stop. Legacy workspace
prepare and explicit individual operations remain available for compatibility
and recovery; they are not the default for a new campaign.

## User-facing behavior and errors

Explain actual blockers and preparation errors. An unsupported graph does not
become executable because structural validation succeeded. Preserve receipts
and read after uncertain writes. Never treat saved preview examples as sends.
Pending calibration or exhausted discovery allowance does not prevent drafting.
If shared workspace operations are unavailable, retain the draft and explain
the limitation; do not silently fall back to individual campaigns.
