# Browser authorization and the exact attempt

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

- `pending`: keep the same attempt and recheck no sooner than the returned
  `retry_after_seconds`. Do not create another attempt just to recover its URL.
- `expired`: do not reuse the link. When the founder continues, start a fresh
  POST and hand off its new link/reference.
- `denied`: explain confirmed consent denial and let the founder decide
  whether to try a new POST. Do not turn a read/network failure into denial.
- `failed`: explain the confirmed failure; use its safe reason if provided.
  Preserve the evidence and use the documented repair before another attempt.
  `error_code: attempt_superseded` means a newer attempt replaced this one;
  use its retained newer reference, never an old grant as proof of completion.
- HTTP/network/status-read error: say the authorization could not yet be
  verified. Preserve the reference and retry GET, even if an ordinary account
  read still reports the previous connection as healthy.

PATCH is only supported configuration. It never marks an account connected,
replaces browser consent or enables sending. Providers and policy may remain
unavailable even when context can be read; report the API's actual result.

Lifty login itself remains the pre-session CLI primitive. Its short-lived
localhost listener must stay alive after the real link is exposed until
completion, cancellation or expiry. Provider-stage POST is for an already
authenticated workspace session; it does not replace that listener lifecycle.
