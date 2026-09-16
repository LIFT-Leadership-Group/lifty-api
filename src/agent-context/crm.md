# CRM

Purpose: connect HubSpot and maintain the existing bounded company mappings.
Read `references.common` and `references.connections` in full.

## Read current state

GET without `attempt_ref` reads the saved HubSpot connection. For mappings,
read `mapping_context`: it contains the authenticated portal's current schema,
mapping versions, supported plan schema and protection rules. Shared context
does not contain portal IDs, property values or workspace mappings.

## First setup and required inputs

POST with an empty object starts HubSpot account/portal consent. Immediately
show the real returned link. The founder selects and authorizes the portal in
HubSpot, not by sending credentials in chat. Retain `attempt_ref` and verify
it with GET after consent. No missing field questionnaire precedes the link.

After verified connection, fetch `mapping_context`; prepare its bounded plan
using actual property/internal option values, portal and version fingerprints.
PATCH applies this existing company mapping operation, including the current
policy for additive schema changes. Its verified receipt and fresh mapping
context establish the result; do not claim that connection alone configured it.

## Later edits

For reconnection, use a fresh POST and verify that exact attempt. A previously
healthy portal grant is not success. For supported company mapping edits,
fetch fresh mapping context and PATCH the complete current plan. Protected
manual/foreign mappings stay protected; arbitrary mapping rewrites are not
supported. PATCH never accepts tokens or a connected flag.

## User-facing behavior and errors

Name HubSpot in the clickable link, explain portal selection, and report only
verified authorization. Follow pending retry timing, expiry, denial and read
failure handling in `references.connections`. Scope/schema/version conflicts
require fresh context or reconnection as indicated; never overwrite protected
fields to clear an error. Connecting/configuring CRM does not send outreach
or authorize an unrelated CRM sync.
