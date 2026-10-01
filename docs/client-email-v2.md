# Client email connections through Lifty

LIF-1115 gives existing client workspace senders the branded V2 Google flow.
Each mailbox has its own attempt and connection. This does not create a founder
profile, replace another mailbox, or enable sending or warmup.

## Client contract

`POST /v1/email/accounts/connect` accepts `workspace`, `sender_ref`, `email` and
`protocol_version: 2`. New accounts return a signed Lifty API URL under
`/unipile/client-email/start`. A mailbox whose connection is still V1 gets
`EMAIL_V1_RETIRED` (LIF-1183): no V1 link is issued for client email. It keeps
sending while connected; moving it to V2 is an operator handoff (LIF-1184).
Older clients receive `CLIENT_UPDATE_REQUIRED` for new accounts.
The legacy Edge endpoint also rejects new V1 issuance and unopened legacy
creation links. Already-opened legacy consent callbacks retain their expiry.

The browser return is only a hint. Completion requires a signed provider event,
matching application/account scope, an authenticated primary mailbox read, and
current workspace membership. A new account cannot adopt migrated V1 metadata.

`POST /v1/email/accounts/connect/status` accepts `workspace` and exactly one of
`attempt_ref` or `connection_ref`. Retain the returned `connection_ref` after
completion. It supports a fresh provider check after the one-hour sign-in link
expires. Provider health and current database authorization are both required
for `connected`; account inventory alone is not a health check.

LIF-1175 adds verified recovery for a retained V2 Gmail that was disconnected by
a transient provider failure. Status reads verify the exact account and primary
mailbox, then reconcile through the caller-authorized database boundary. A signed
running webhook uses the same evidence and recovery rule. Gmail health is
independent of Calendar health. Manual disconnects and terminal provider failures
require explicit reconnect; recovery leaves sending paused and warmup unchanged.

Deploy the Functions migration
`20261001210001_lif1175_verified_email_health.sql` and compatible V2 receiver before
this API revision. The new `health` RPC operation is required for retained V2
status reads. Existing V1 status behavior is unchanged.

## Release order

1. Merge the Functions change and follow its existing database workflow. Both
   LIF-1115 migrations and the accepted source catalog must pass the normal
   security gates. The new RPC advertises `lif1115.client-email.v2`.
2. Follow the connector and webhook deployments triggered by that merge. The
   webhook workflow checks both new database contracts before deployment.
   Confirm the existing signed V2 webhook subscription includes `email.new`.
   Only authenticated INBOX events for an exact app/account/connection binding
   enter client reply handling. Founder inbox polling retains ownership; bounce
   classification is outside this contract.
3. Deploy this API revision through its normal merge-triggered workflow. Keep
   the configured Lifty V2 application, hosted origin and callback settings in
   agreement with the database. Never install the client ahead of these backend
   prerequisites.
4. Prepare a new CLI version and its required release artifacts, then publish
   through the normal CLI release process. This implementation does not itself
   bump or publish a package. Update David's installation and reload his agent
   session before generating a fresh link.

## Live acceptance

Use an authorized test workspace and a personal Gmail address never previously
connected to Lifty or Unipile. Verify Lifty branding through consent and the
return page, then verify the exact address and retain its connection reference.
Leave it connected for at least 65 minutes without reconnecting and check that
same reference again. Confirm a fresh provider read succeeds and sending and
warmup remain off. Never delete or migrate an existing account to make this test
pass. Contract tests simulate elapsed time; they do not prove real Google token
refresh. No live sending is part of this acceptance test.
