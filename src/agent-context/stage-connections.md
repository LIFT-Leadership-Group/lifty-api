# Browser authorization and the exact attempt

This common contract describes the founder-stage GET/POST operations.
The explicit `sending-accounts.client_connect` and `client_connect_status`
operations have their own published contract: exact workspace, sender and
email selection; a signed opaque `attempt_ref`; and POST status verification.
Follow their sending-accounts instructions, including per-connection campaign
pauses. Do not substitute the founder stage's UUID attempt or summary for a
client mailbox attempt.

Start connection or reconnection with the stage POST operation. It returns
`status: authorization_required`, an opaque `attempt_ref`, the actual
`connection_url`, and absolute `expires_at`. Keep that reference with its
stage/channel. It is workspace-scoped: never reuse it in another workspace or
provider. Do not derive it from a URL, timestamp or previous healthy grant.

Immediately show the returned URL as a clickable Markdown link, name the
provider, and explain that the founder chooses the browser/account. Do not open
the link automatically, invent a link, inspect its tokens or wait for consent
before making it visible. For email, let the hosted flow select provider and
account; do not precede it with an email-address or mailbox-use questionnaire.
An existing known address may label the link but is not required to obtain it.

After the founder finishes, GET the same stage with `attempt_ref` in the query;
include `channel` for sending accounts. Only `status: connected`, `verified:
true` and the matching `attempt_ref` confirm this authorization. Reading a
connected account without the reference is a state read, not attempt evidence.
This rule also applies when reconnecting an account whose old grant still works.
The verified receipt proves completion of that authorization and its binding to
the current stored healthy grant; it does not claim a fresh independent provider
availability check. GET without `attempt_ref` reads current connection health.
Lifty's return page may already tell the founder the account connected or did
not; it uses the same server checks, but still verify with GET before continuing.

- `pending`: keep the same attempt and recheck no sooner than the returned
  `retry_after_seconds`. Do not create another attempt just to recover its URL.
- `expired`: do not reuse the link. When the founder continues, start a fresh
  POST and hand off its new link/reference.
- `denied`: explain confirmed consent denial and let the founder decide
  whether to try a new POST. Do not turn a read/network failure into denial.
- `failed`: explain the confirmed failure; use its safe reason if provided.
  Preserve the evidence and use the documented repair before another attempt.
  A sending-account `failure_code: account_taken` means the authorized
  LinkedIn profile or mailbox is already bound to another workspace. Another
  link will not fix it: the founder connects a different account here or
  resolves the binding in the workspace that holds it. Lifty never binds the
  duplicate LinkedIn provider account it created; nothing else to clean.
  `authorization_cancelled`, `account_exists` and `provider_rejected` repeat
  the error the provider reported when it sent the founder back; no signed
  authorization arrived. After `authorization_cancelled`, offer a fresh POST
  when the founder is ready. After `provider_rejected`, offer one fresh POST
  and ask for operator review if it fails again. `account_exists` means the
  mailbox or LinkedIn profile is still linked at the provider from an earlier
  setup, so another link fails the same way. If it is the account this
  workspace already saved, disconnect this workspace's email (that closes the
  still-open selection attempt) and then reconnect with an ordinary POST (no
  `select_account`); a POST while that attempt is open returns the same
  attempt. Otherwise it needs operator review. Never disconnect another
  workspace or delete a provider account to get around it. These codes come from the
  founder's browser, not a verified outcome: a later `connected` for the same
  attempt means they finished in another tab, and that result wins.
  `error_code: attempt_superseded` means a newer attempt replaced this one;
  use its retained newer reference, never an old grant as proof of completion.
- HTTP/network/status-read error: say the authorization could not yet be
  verified. Preserve the reference and retry GET, even if an ordinary account
  read still reports the previous connection as healthy.

PATCH is only supported configuration. It never marks an account connected,
replaces browser consent or enables sending. Providers and policy may remain
unavailable even when context can be read; report the API's actual result.

Lifty sign-in belongs to the current client. Claude and ChatGPT use their
connector's OAuth flow; the CLI handles its own login. Provider-stage operations
require an authenticated workspace and do not replace Lifty sign-in.
