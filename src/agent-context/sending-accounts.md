# Sending accounts

A sending account is one LinkedIn account or mailbox owned by one sender
(`senders` guide). Every workspace uses the same operations; send the chosen
workspace as `references.common` describes. Customers never see the provider
behind Lifty's connection pages; do not name it.

## Read

`sending_accounts_get` (`lifty get sending-accounts`, optional query
`sender_id`, `channel`) lists accounts including disconnected history. Each has:

- `status`: `connected`, `needs_reconnect` (Lifty lost access; the person must
  sign in again) or `disconnected` (explicitly removed by the customer or an
  operator).
- `state`: `active` or `paused`, the account's own usage switch, independent of
  `status`.
- `checked_at` and `observation.state`: the last verified provider check and
  whether it is recent enough. `unverified` means the last known facts are
  older than the freshness window; it is not a disconnection and not a reason
  to reconnect by itself. Sending waits until a fresh check.
- `declaration`: what the person confirmed on Lifty's connect page.
- `sends`: sends today and over the last seven days.

Reads never check or change a provider. A failed read is unknown: retry it;
never report an account as disconnected or missing from a failed read.

## Connect

1. Resolve the person with `senders_get` and use their `id` (create the sender
   first only if absent). Ask whose account it is when unclear.
2. `sending_accounts_connect` with `{"sender_id":"<id>","channel":"linkedin"|"email"}`.
   Ask nothing else: Lifty's connect page asks the person's declaration (for
   LinkedIn, that it is their habitual personal account with no other
   automation tool; for email, a mailbox they already use or a dedicated
   sending mailbox), then opens the sign-in. Only Google is offered for new
   mailboxes. A sender has at most one LinkedIn account
   (`LINKEDIN_ALREADY_CONNECTED`: reconnect that one instead).
3. Immediately show the returned `connection_url` as a clickable link and say
   whose account it connects. Do not open it yourself. An open attempt for the
   same sender and channel is reused (`created:false`): show its link again.
4. After the person finishes, read `sending_accounts_attempt` with
   `path.id` = the returned `id`, with bounded backoff. `connected` gives the
   new `account_id`. A failed or timed-out read is unknown, not failure: keep
   polling the same attempt. `failed` reasons: `canceled` (sign-in not
   finished; offer a new connect when ready), `account_in_use` (the account is
   live in another workspace; another link will not fix it), `identity_mismatch`
   (another mailbox/profile signed in), `provider_rejected` (offer one new
   attempt, then ask for LIFT review). `expired`: start a new connect.

Connecting never activates a campaign or sends anything.

## Reconnect

`sending_accounts_reconnect` with `path.id` = the account `id` returns a
`connection_url` like connect. The same mailbox or LinkedIn profile must sign
in; another one fails with `identity_mismatch`. After `needs_reconnect` the
account keeps its usage state. After an explicit disconnect it comes back
`paused` until resumed. Reconnecting never resumes or activates a campaign.
`CONNECT_UNAVAILABLE` means Lifty cannot reconnect this account through its
current sign-in; ask LIFT support rather than connecting a different account.

## Pause and resume

`sending_accounts_pause` / `sending_accounts_resume` with `path.id`, only when
the user asks. Pause stops new work on that account (in-flight sends settle);
resume makes it usable again only when it is connected and every campaign gate
allows. Resume refuses a disconnected account (`ACCOUNT_DISCONNECTED`):
reconnect first. Neither changes other accounts or activates a campaign.

## Disconnect

Only with the user's explicit yes in this conversation:
`sending_accounts_disconnect` with `path.id` and `{"confirm":true}`. The account
is paused and disconnected at once (new sends stop; already submitted sends
keep their history and limits), then Lifty removes its access at the provider.
200 means access removal is confirmed (`access_revoked_at`). 202 means the
account is blocked but removal is not confirmed yet: repeat the same request a
few times with short waits; no new consent is needed. If it stays unconfirmed,
tell the user the account is blocked and removal is pending, and repeat it later
on the same account. Never claim access was removed without `access_revoked_at`.
Other accounts are unaffected. To change mailboxes, connect the new one and
disconnect the old one.

## Email warmup after connection

Warmup, placement and inbox health keep their own operations. They take the
explicit `workspace` and, as `connection_ref`, the email account's `id` from
`sending_accounts_get`; `connection_ref` is required when the workspace has
several email accounts. GET inputs belong in query; POST inputs belong in body.
Mailivery authorization is a separate Google OAuth step from the account
connection. Show the returned branded setup link for that exact mailbox; the
owner must choose the same Google account again. There is no app-password
fallback.

Keep every requested connection's campaigns paused throughout its own 21
active warmup days, starting from its actual Mailivery warmup. Paused days and
problem days do not count. Read the returned progress and recommendation;
do not calculate release from the day a link was generated. A healthy check
from the last 24 hours is also required. `outreach_unlocked` is warmup
eligibility only. `campaign_send_paused` reports the separate campaign hold;
`campaign_release_required: true` means an operator must explicitly release
campaign sending after review. `awaiting_release` confirms that warmup alone
has not enabled campaigns. Never claim sending is enabled just because the
warmup reaches 21 days.

Use `warmup_pause`, `warmup_resume` or `warmup_remove` with the same two
selectors when requested. Warmup resume never resumes campaigns. Report each mailbox
separately; readiness or consent for one cannot satisfy another mailbox.

After the email account is connected, call `warmup_status` with the explicit
`workspace` (and `connection_ref` when needed) in query. Its `mailbox_use`
decides what to tell the founder: `personal` is a mailbox the person already
uses (declared habitual) and `outreach` a dedicated sending mailbox. Use the returned `recommended_go_live` message and
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

`warmup_start` with the same `workspace` in body returns the actual setup
link. When it points to Lifty, show it as "Set up warmup for your mailbox".
The page shows the mailbox, asks for the name on warmup emails and has one
"Continue with Google" button. Lifty sets the warmup settings. Google must
verify that exact address before Lifty sends tokens to Mailivery. Lifty
forwards those tokens once without storing or logging them. The setup flow
does not create another email address.

Warmup setup uses Google OAuth only. Never request an App Password or route the
founder to a legacy password form or Microsoft consent flow. Mailivery needs
separate mailbox access; the account connection's grant cannot be reused. If the returned link
or status does not support the current Lifty Google setup, report the actual
blocker and involve support. Do not create another account or invent a link.

After the founder finishes, read `warmup_status` again. The state moves from
waiting for the Mailivery connection to warming after Lifty's next check.
`warmup_start` fails with `EMAIL_CONNECTION_REQUIRED` until a connected,
verified email account exists, and with `EMAIL_WARMUP_MAILBOX_TAKEN` when
another Lifty workspace already warms the same mailbox. It fails with
`EMAIL_WARMUP_DNS_INVALID`, without creating a link, when the mailbox domain
has no valid SPF, DMARC or MX record. Tell the founder which record the
message names and call `warmup_start` again once it is published. After a removal,
status shows `Removed`; `warmup_start` can set up a new warmup with a new link only
when previous provider creation is resolved. An ambiguous handoff is never
retried automatically: check status and involve support, rather than trying
another account or bypassing the setup hold.

Use `warmup_pause`, `warmup_resume` or `warmup_remove` only when the founder
asks, with the same `workspace` in body. Lifty applies
the request at its next check. A pending removal wins over pause or resume,
and resume on a running warmup only cancels a pending pause. For an `outreach`
account, pausing or removing warmup delays or blocks sending; say so and get
an explicit yes first.

## Placement tests

A placement test shows where a mailbox's email lands: inbox, spam or missing,
across Gmail, Microsoft (Outlook) and other providers. It runs through
Mailivery and only for a mailbox Mailivery is already warming. Read
`placement_status` with the explicit `workspace` and, when the workspace has
more than one warmed mailbox, its `connection_ref`.

Only call `placement_start` after the user explicitly agrees to what it does.
Mailivery sends one email from that mailbox to roughly 20-40 of its seed
inboxes, and each test uses one Mailivery test credit. Use the subject and
plain-text body of the first email of the real sequence, and send
`confirm: true`. Retrying the same start returns the test already in progress.
A second test within 24 hours of a completed one is refused.

A test takes about 10-20 minutes after Lifty creates it. Read
`placement_status` again and repeat its `label`; do not compute a verdict
yourself. `uncertain` means Lifty is checking whether Mailivery created the
test and will not create a second one. `did_not_run` is not a placement
result.

When `gates_sending` is true (LIFT client mailboxes), the mailbox can send
campaign email only with a passing test from the last 10 days, after 21 active
warmup days and an explicit operator release. A passing test never releases the
mailbox or starts campaigns by itself. For founders it is advisory.

## Inbox health

To answer how inboxes are doing, what a sender's last placement tests were,
or when an inbox will be ready, use `deliverability` with the explicit
`workspace` in query. Add `sender` (a sender `id` from `senders_get`, or
`unassigned`) or `mailbox`; add `detail: placement` with one
`mailbox_ref` only when the stored test reports are needed. Follow
`next_cursor` until it is null before describing all inboxes.

Report each inbox's `label`, `description` and `reasons` as returned; do not
recalculate health, readiness or dates. A pending or failed test run is not a
placement result, a configured campaign is not evidence of sending, and
missing or out-of-date evidence is not healthy. Workspace health covers the
whole workspace, not one inbox. This read never starts a placement test or
changes sending; propose those only as separate, explicitly requested actions.

## Campaigns and accounts

Campaigns refer to senders. Which of a sender's mailboxes sends is a campaign
decision; a reconnected or replaced mailbox never changes an approved
campaign. A connected account does not authorize any email, message or
invitation: use campaign previews and explicit approval/activation.
Connection can proceed while the sample or new research waits for the weekly
reset.
