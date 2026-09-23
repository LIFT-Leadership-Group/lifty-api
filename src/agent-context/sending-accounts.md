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
happens on the hosted email connection screen for a new account. A saved account
reconnects with its existing provider. Do not add an email-address or
mailbox-use questionnaire, ask for a password, or create an artificial address.
Hosted selection must satisfy the existing provider/policy checks afterward.

Show the actual returned link immediately as “Connect LinkedIn” or “Connect
your email account” in the founder's language. Keep `attempt_ref` and verify
with GET using both the same channel and reference after authorization.

## Email warmup after connection

After GET confirms the email account is connected, read
`lifty email warmup status --workspace <workspace>`. Its `mailbox_use` decides
what to tell the founder. Use the returned `recommended_go_live` message and
date; do not compute your own.

- `personal`: campaigns can start now and warmup is optional. Explain the
  tradeoff in plain words. Mailivery gets access to the mailbox, and warmup
  emails and their replies pass through the inbox. In return it builds sending
  reputation. Start warmup only if the founder says yes.
- `outreach`: warmup is required before any campaign sends. Lifty needs 21
  active warmup days. Paused days and days with a problem don't count, so the
  go-live date moves later if either happens. Give the returned date and
  suggest what to prepare meanwhile: targeting, copy and schedule. Campaign
  previews can be prepared and approved now; activation waits for the unlock.

`lifty email warmup start --workspace <workspace>` returns the actual setup
link. When it points to Lifty, show it as "Set up warmup for your mailbox".
The page shows the mailbox, asks for the name on warmup emails and has one
"Continue with Google" button. Lifty sets the warmup settings. Google must
verify that exact address before Lifty sends tokens to Mailivery. Lifty
forwards those tokens once without storing or logging them. The setup flow
does not create another email address.

Legacy servers may still return a Mailivery-hosted link. That Google form
requires a Google App Password, not the regular Google password. Explain this
before opening it, and do not describe a legacy link as OAuth-enabled.
Mailivery needs separate mailbox access; Unipile's grant cannot be reused.
After the founder finishes, check
`status` again. The state moves from waiting for the Mailivery connection to
warming after Lifty's next check. If status says Microsoft consent is pending,
the founder finishes the consent step inside Mailivery; do not run `start` for
a new link. `start` fails with `EMAIL_CONNECTION_REQUIRED` until a connected,
verified email account exists, and with `EMAIL_WARMUP_MAILBOX_TAKEN` when
another Lifty workspace already warms the same mailbox. After a removal,
status shows `Removed`; `start` can set up a new warmup with a new link only
when previous provider creation is resolved. An ambiguous handoff is never
retried automatically: check status and involve support, rather than trying
another account or bypassing the setup hold.

Pause, resume and remove only when the founder asks:
`lifty email warmup pause|resume|remove --workspace <workspace>`. Lifty applies
the request at its next check. A pending removal wins over pause or resume,
and resume on a running warmup only cancels a pending pause. For an `outreach`
account, pausing or removing warmup delays or blocks sending; say so and get
an explicit yes first.

## Later edits

Reconnection uses POST again and must verify the new attempt, even while the
old account is healthy. PATCH is unsupported (405): account identity, limits,
provider policy and sending enablement are not freely writable settings.
Use the supported authorization flow to replace consent; do not patch around it.

When the founder explicitly wants to choose another email account or provider,
use the supported email disconnect command first if the saved account is still
connected. After the requested disconnect succeeds, POST
`{"channel":"email","select_account":true}`. This opens a new hosted provider
selector with Google, Microsoft and IMAP/SMTP and leaves sending disabled.
An ordinary POST without `select_account: true` reconnects the saved mailbox;
it does not reopen provider selection. Do not disconnect a working account just
to preview the selector. Selection does not erase earlier account history or
restart campaigns, and still requires verified authorization for the new attempt.

## User-facing behavior and errors

Explain confirmed pending, expired, denied or failed attempts without exposing
callback contents. Retry status reads using the same reference and wait the
returned retry interval. When a known mailbox already exists at the provider,
Lifty reconnects that account instead of creating another one, and a mailbox
held live by another workspace fails before any link is issued. Never interpret a failed read as disconnected or a
previous connected grant as the new attempt. A verified connection does not
authorize any email, message or invitation; use campaign previews and explicit
approval/activation before sending. Connection can proceed while sample review
or new-discovery allowance is blocked.
