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
PATCH with `operation: destination` and `values` containing the actual channel
ID/name saves the existing destination. Read its returned reference; PATCH
with `operation: route` and the current notification type, destination reference
and enabled flag saves the routing rule. Read GET to confirm the saved setup.

## Later edits

Use the same supported PATCH for a destination or routing change. Reconnect
Slack via a fresh POST and verify its exact attempt; old healthy Slack state
does not prove completion. PATCH cannot authorize Slack, set connection state,
or silently send a test notification.

## User-facing behavior and errors

Describe which business event goes to which Slack channel. Explain unavailable
channels or destinations accurately and refresh channel/state reads before
retrying. Follow the common pending/expiry/denial/reconnection rules; a failed
status request means authorization could not be verified, not disconnected.
Connecting Slack does not authorize sending outreach or a test message.
