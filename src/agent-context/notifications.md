# Notifications

Purpose: authorize Slack and choose supported notification destinations/routes.
Read `references.common` and `references.connections` in full.

## Read current state

GET without `attempt_ref` reads saved notification types, destinations, routes
and Slack status. The supporting `channels` GET lists currently available Slack
channels. Workspace/channel IDs and names are private authenticated data.

## First setup and required inputs

POST with an empty object starts Slack workspace consent. Immediately show
the actual returned link, then verify its exact `attempt_ref` with GET after
authorization. The founder selects the Slack workspace in the consent screen;
do not request tokens or infer authorization from channel data.

After verified authorization, read `channels` and obtain only the missing
channel choice. Explain when Lifty needs to be invited to a private channel.
In MCP, `notifications_destination_upsert` takes `body` with the actual
`channel_id` and `channel_name`. Read its returned destination reference, then
`notifications_route_set` takes `body` with `notification_type`,
`destination_ref` and `enabled`. Each tool performs only its named operation;
do not include an `operation` selector or `values` wrapper. Read
`notifications_get` to confirm the saved setup.

The CLI and HTTP API retain PATCH with `operation: destination` or
`operation: route` and the corresponding fields inside `values`.

## Later edits

Use the matching MCP tool, or the existing CLI/HTTP PATCH, for later changes. Reconnect
Slack via a fresh POST and verify its exact attempt; old healthy Slack state
does not prove completion. PATCH cannot authorize Slack or set connection state.
`test` posts one visible test message to a saved destination; send it only when
the founder asks to check a channel. `disconnect` removes the Slack grant from
the current workspace after the founder confirms; notifications stop until Slack
is reconnected.

## User-facing behavior and errors

Describe which business event goes to which Slack channel. Explain unavailable
channels or destinations accurately and refresh channel/state reads before
retrying. Follow the common pending/expiry/denial/reconnection rules; a failed
status request means authorization could not be verified, not disconnected.
Connecting Slack does not authorize sending outreach or a test message.
