# Sending accounts

Start with `whoami`. If it lists several workspaces and the user has not named
one, ask which workspace they mean, naming the listed workspaces, before any
other read. Do not try `summary_get` or GET to find out; send the chosen
workspace with every call as `references.common` describes. For a LIFT-managed
client workspace (`self_service: false` in `whoami`), start with
`client_accounts` below using its exact slug, and never use the founder
operations for it. `WORKSPACE_SELECTION_REQUIRED` means the same: ask which
workspace, then continue.

For a self-service workspace (always the case with a single workspace),
refresh `summary_get` with approval before proposing setup or changes in a new
authenticated session.
Do not infer a founder workspace from summary or create a founder profile to
manage client mailboxes. Reuse verified saved state. Unavailable reads require
a retry, not assumptions that setup is missing.

Purpose: connect the requested sending channel through hosted Unipile flows.
Use `summary_context` with `path: {"task":"sending-accounts"}` to read the
current operations, `references.common` and `references.connections` in full.
The shared guide applies in every client; follow each tool's path/query/body schema.

## Read current state

For a named client workspace, use `client_accounts` with query
`{"workspace":"<slug-or-uuid>"}`. It returns the workspace identity,
available senders, each email connection and its campaign pause. Select the
intended sender from that returned roster; do not invent its UUID, choose an
unrelated sender, or reuse one from another workspace. One sender can own
multiple mailboxes. If no sender is available, explain that a workspace
operator must add one before setup. Do not request administrative credentials.

The remaining main GET/POST instructions describe the founder flow.
GET requires `channel: linkedin` or `channel: email` in the query. It reads
the current account, health and provider policy. Add `attempt_ref` when
verifying authorization; ordinary current-account state is insufficient.
This check can complete previously authorized bindings, update health, and
remove unreferenced duplicate LinkedIn provider accounts. Obtain approval
before calling it; it does not authorize outreach.

## Sender identity

For the founder flow, call `senders` before starting an account connection.
A sender is a person and may own both email and LinkedIn. Keep the returned
sender references and account associations; never infer ownership from matching
names, email domains, the Lifty login, or a shared workspace.

If the roster is empty, the first sender defaults to the account creator.
Do not ask whether to create a sender or choose an existing one. Use the saved
creator name. If it is missing, ask only for their name, then include
`sender: {"kind":"self","name":"<confirmed person name>"}` in POST.
With a saved creator name, the first POST may omit `sender`.

For an additional account, ask which listed person owns it or whether to create
a new sender. Include either `sender: {"kind":"existing","sender_ref":"<returned reference>"}`
or `sender: {"kind":"new","name":"<confirmed person name>"}`. Reuse a choice
already made in this conversation. Use person names such as Valen, never channel
labels such as LinkedIn or Email, and never name a sender after an inbox address.

Reconnects keep their existing sender and need no repeated ownership question.
A pending attempt also retains its selected sender: continue that attempt rather
than selecting a different person. A sender conflict requires reviewing the
saved binding; never disconnect or move an account to bypass it. After successful
authorization, read `senders` again to confirm the exact connection is attached
to the selected person. The returned connection status alone does not prove a
new authorization; continue the exact-attempt verification below as well.

## Email signature

Lifty adds the sender's plain-text signature to the end of every campaign
email, after a blank line. While a sender has none, its email campaigns show
`email_signature_missing` and cannot compose, be approved or send.

After an email account is connected, and whenever `email_signature_missing`
appears, call `signature` to read each sender's saved signature. If it is
missing, ask the founder for the exact signature text for that sender. The
signature is never written by AI: do not draft, suggest, complete or polish it,
and add nothing the founder did not write (no title, company, link or
tagline). If they only want their first name, that is the whole signature.
Save exactly their text with `signature_save` and body
`{"sender_ref":"<returned sender reference>","signature":"<their exact text>"}`.
It must be plain text of at most 500 characters, with no HTML, and any link
must start with `https://`.

Saving a different signature composes unsent campaign previews again; emails
already approved keep the signature they were approved with. Show the new
previews before approval.

## First setup and required inputs

For a named client workspace, use `client_connect` with
`{"workspace":"<slug-or-uuid>","sender_ref":"<returned-sender-uuid>","email":"<exact-address>","protocol_version":2}`.
Connect each requested mailbox separately under its intended sender. Show the
actual returned `connection_url` as a clickable link labeled with that exact
mailbox. New mailboxes use the Lifty-branded Google flow. The owner signs into
the matching Google account and approves access;
no separate Unipile signup is needed. Keep the returned `attempt_ref` private
and retain it with that workspace, sender and email. Never guess it or use a
previous healthy connection as evidence of the new authorization.

After consent, call `client_connect_status` with body
`{"workspace":"<same-workspace>","attempt_ref":"<retained-reference>"}`.
Only `status: connected` with its returned `connection_ref` confirms the
selected mailbox. Keep checking the same attempt after pending or an
unavailable read. `needs_authorization` or `needs_reconnect` requires the owner
to finish or renew consent; `conflict` needs operator review. Do not create
another account to bypass a conflict. An expired attempt needs a fresh link
after reading current accounts. After a connection is verified, check it later with
`client_connect_status` and `{"workspace":"<same-workspace>","connection_ref":"<verified-connection>"}`.
This performs a fresh provider check even after the sign-in link expires. Use this
for the 65-minute renewal test; do not reconnect or use an inventory row as proof
of current provider health. Membership is checked again on every read.
These operations require no founder onboarding. `CLIENT_UPDATE_REQUIRED` means
update the CLI and request a fresh link; never work around it by generating a
legacy provider link. A new mailbox never falls back to the old connection flow.
Existing accounts retain their own connection flow and require no bulk migration.
Connecting alone starts neither warmup nor campaigns. Keep both off for a
connection-only test; only call `warmup_start` when the user requests warmup.

POST selects the channel. For LinkedIn, obtain only missing current-contract
declarations (`timezone`, personal `account_use`, and no `other_automation`)
before the hosted LinkedIn account connection. Preserve existing policy limits.
For email, use `channel: email` plus the sender choice above: provider/account selection
happens on the hosted email connection screen for a new account. A saved account
reconnects with its existing provider. Do not add an email-address or
mailbox-use questionnaire, ask for a password, or create an artificial address.
Hosted selection must satisfy the existing provider/policy checks afterward.

Show the actual returned link immediately as "Connect LinkedIn" or "Connect
your email account" in the founder's language. Keep `attempt_ref` and verify
with GET using both the same channel and reference after authorization.

## Email warmup after connection

For client mailboxes, use `warmup_status` and `warmup_start` with both the
explicit `workspace` and the verified `connection_ref`. GET inputs belong in
query; POST inputs belong in body.
Mailivery authorization is a separate Google OAuth step from Unipile. Show
the returned branded setup link for that exact mailbox; the owner must choose
the same Google account again. Client setup has no app-password fallback.

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

For the founder flow without `connection_ref`, continue as follows.
After GET confirms the email account is connected, call `warmup_status` with
the explicit `workspace` in query. Its `mailbox_use` decides
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

`warmup_start` with the same `workspace` in body returns the actual setup
link. When it points to Lifty, show it as "Set up warmup for your mailbox".
The page shows the mailbox, asks for the name on warmup emails and has one
"Continue with Google" button. Lifty sets the warmup settings. Google must
verify that exact address before Lifty sends tokens to Mailivery. Lifty
forwards those tokens once without storing or logging them. The setup flow
does not create another email address.

Warmup setup uses Google OAuth only. Never request an App Password or route the
founder to a legacy password form or Microsoft consent flow. Mailivery needs
separate mailbox access; Unipile's grant cannot be reused. If the returned link
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
`workspace` in query. Add `sender` (a ref from `client_accounts` or
`senders`, or `unassigned`) or `mailbox`; add `detail: placement` with one
`mailbox_ref` only when the stored test reports are needed. Follow
`next_cursor` until it is null before describing all inboxes.

Report each inbox's `label`, `description` and `reasons` as returned; do not
recalculate health, readiness or dates. A pending or failed test run is not a
placement result, a configured campaign is not evidence of sending, and
missing or out-of-date evidence is not healthy. Workspace health covers the
whole workspace, not one inbox. This read never starts a placement test or
changes sending; propose those only as separate, explicitly requested actions.

## Later edits

Reconnection uses POST again and must verify the new attempt, even while the
old account is healthy. PATCH is unsupported (405): account identity, limits,
provider policy and sending enablement are not freely writable settings.
Use the supported authorization flow to replace consent; do not patch around it.

When the founder explicitly wants to choose another email account or provider,
the saved account must first be disconnected if it is still connected.
Disconnect only after the founder explicitly confirms in this conversation:
`disconnect` with `{"channel":"email","confirm":true}` (or `"linkedin"`)
disconnects the current workspace's account and returns its new state. Future
campaign steps on that channel stay blocked; history and consumed sending
limits are kept. For an explicitly named client workspace use
`client_email_disconnect` or `client_linkedin_disconnect`; check client LinkedIn
with `client_linkedin_status` and reconnect it with `client_linkedin_connect`.
After that authorized disconnect is verified, POST
`{"channel":"email","select_account":true,"sender":{"kind":"existing","sender_ref":"<selected sender>"}}`
(or the confirmed new-sender choice). This opens a new hosted provider
selector for Google and leaves sending disabled. Existing Microsoft and IMAP/SMTP
connections retain their reconnect flow; new connections for those providers
are unavailable until equivalent account verification is supported.
An ordinary POST without `select_account: true` reconnects the saved mailbox;
it does not reopen provider selection. Do not disconnect a working account just
to preview the selector. Selection does not erase earlier account history or
restart campaigns, and still requires verified authorization for the new attempt.
The workspace campaign sends from the workspace's current mailbox: a reconnect
or a replaced account changes neither its version nor its approval. Do not
modify the campaign to point at the new connection; after a disconnect the
founder resumes it by activating the same version.

## User-facing behavior and errors

Explain confirmed pending, expired, denied or failed attempts without exposing
callback contents. A failed attempt with `authorization_cancelled`,
`account_exists` or `provider_rejected` means the provider reported that error
when it sent the founder back; follow the connection-stage guidance for each. Retry status reads using the same reference and wait the
returned retry interval. When a known mailbox already exists at the provider,
Lifty reconnects that account instead of creating another one, and a mailbox
held live by another workspace fails before any link is issued. Never interpret a failed read as disconnected or a
previous connected grant as the new attempt. A verified connection does not
authorize any email, message or invitation; use campaign previews and explicit
approval/activation before sending. Connection can proceed while the sample
or new research is waiting for the weekly reset.
