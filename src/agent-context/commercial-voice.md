# Commercial voice

Purpose: preserve the customer's identity, value proposition and preferred
commercial language. This is distinct from Lifty's own identity/tone Markdown.
Read `references.common` and `interview`.

## Read current state

GET returns saved tone values. Read `generation_context` before changes and
reuse the founder's confirmed language/examples already present there.

## First setup and required inputs

Collect only missing business voice, proposition and call-to-action decisions
required by the current draft/generation schema. Initial voice participates
in the full first onboarding configuration: use `onboarding_context`, generate
locally, and POST the existing `draft` plus `configuration` once. Do not repeat
the onboarding transaction for a workspace already configured. Read the import
receipt and the saved voice afterward.

## Later edits

PATCH uses `section: tone`, changed `values` (for example identity, value_prop
or cta), and the local `configuration` required by fresh generation context.
Preserve targeting/personas and unrelated tone fields. Wait for the update
receipt and GET readback before saying the new voice is applied.

## User-facing behavior and errors

Play back the proposed wording and its business purpose; avoid a generic voice
questionnaire when examples already answer it. Voice configuration does not
edit or approve an existing campaign preview: use the campaign stage for exact
copy changes and obtain fresh approval there. Respect protected prompt and
stale generation errors; do not turn an uncertain response into another write.
