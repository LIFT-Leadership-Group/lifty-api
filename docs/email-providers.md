# Email connection providers

Hosted authentication offers Gmail/Google Workspace, Outlook/Microsoft 365,
and IMAP/SMTP through the documented Unipile V1 provider values `GOOGLE`,
`OUTLOOK`, and `MAIL`. The existing habitual-mailbox declaration, workspace
ownership, exact account binding, and ten-email daily budget still apply.
Connecting a mailbox does not approve or activate outreach.

Gmail verifies the authenticated owner profile and exactly one primary alias.
Outlook verifies the authenticated owner's email against the account username.
Delegated/shared Outlook targets (`mailbox_id`) are excluded because their
sender can differ from the authenticated user.

IMAP has no provider-certified primary address. Under Juan's September 17
decision, the beta accepts authenticated configured sender access without an
additional email challenge. Both IMAP and SMTP usernames must be the same valid
email address. Their hosts, ports, and usernames must agree between account and
own-profile readback, and every reported source must be healthy. Jobs repeats
these checks before acquiring the final send permission. This does not establish
an immutable physical mailbox identity or equivalence between aliases.

The existing reply reader uses V1 account/from/to/date filters without `search`;
the special Microsoft/IMAP search restrictions do not apply to that request.
Unknown sends remain blocked for reconciliation, never blindly resent.

Sources checked September 17, 2026:

- [Hosted authentication](https://developer.unipile.com/reference/hostedcontroller_requestlink)
- [Account readback](https://developer.unipile.com/reference/accountscontroller_getaccountbyid)
- [Owner profile](https://developer.unipile.com/reference/userscontroller_getaccountownerprofile)
- [Microsoft delegated mailbox behavior](https://developer.unipile.com/docs/microsoft-oauth)
- [Email list filters](https://developer.unipile.com/reference/mailscontroller_listmails)

This rollout uses automated contract tests. Juan deferred live account
connection/send/reply acceptance; no such acceptance is claimed.
