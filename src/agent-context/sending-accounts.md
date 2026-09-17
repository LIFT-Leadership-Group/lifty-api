# Sending accounts

Before proposing setup or changes in a new authenticated session, read `summary.get`
using `context summary`. Reuse verified saved state. Read business before asking
for a website, sending-accounts before reconnecting, and campaigns before writing
templates. Unavailable reads require a retry, not assumptions that setup is missing.

Purpose: connect the requested sending channel through hosted Unipile flows.
Read `references.common` and `references.connections` in full.

## Read current state

GET requires `channel: linkedin` or `channel: email` in the query. It reads
the current account, health and provider policy. Add `attempt_ref` when
verifying authorization; ordinary current-account state is insufficient.

## First setup and required inputs

POST selects the channel. For LinkedIn, obtain only missing current-contract
declarations (`timezone`, personal `account_use`, and no `other_automation`)
before the hosted LinkedIn account connection. Preserve existing policy limits.
For email, the request is simply `channel: email`: provider/account selection
happens on the hosted email connection screen. Do not add an email-address or
mailbox-use questionnaire, ask for a password, or create an artificial address.
Hosted selection must satisfy the existing provider/policy checks afterward.

Show the actual returned link immediately as “Connect LinkedIn” or “Connect
your email account” in the founder's language. Keep `attempt_ref` and verify
with GET using both the same channel and reference after authorization.

## Later edits

Reconnection uses POST again and must verify the new attempt, even while the
old account is healthy. PATCH is unsupported (405): account identity, limits,
provider policy and sending enablement are not freely writable settings.
Use the supported authorization flow to replace consent; do not patch around it.

## User-facing behavior and errors

Explain confirmed pending, expired, denied or failed attempts without exposing
callback contents. Retry status reads using the same reference and wait the
returned retry interval. Never interpret a failed read as disconnected or a
previous connected grant as the new attempt. A verified connection does not
authorize any email, message or invitation; use campaign previews and explicit
approval/activation before sending. Connection can proceed while sample review
or new-discovery allowance is blocked.
