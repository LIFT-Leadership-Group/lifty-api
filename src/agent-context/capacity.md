# Capacity

Purpose: explain actual operating capacity and discovery allowance.
Read `references.common` first.

## Read current state

GET returns workspace configuration and the authenticated Apollo allowance:
limit, used, reserved, remaining, whether it applies, key source and reset time.
Use these saved values; never infer allowance from lead counts, lane weights,
static examples or another workspace. Read this before new discovery.

## First setup and required inputs

No founder input or setup write is required for this stage. POST is explicitly
unsupported (405): capacity is managed by existing platform/provider policy.
The platform-default allowance and customer-owned-key posture remain as
returned by the API. Do not create an allowance configuration workflow.

## Later edits

PATCH is explicitly unsupported (405). The workspace daily discovery target,
ICP lane allocation weights/labels, weekly counters and provider limits are
read-only here. Do not send `daily_target`, `daily_discovery_target`, or labels
through another config route to bypass this restriction.

## User-facing behavior and errors

Explain remaining capacity and the actual reset timestamp in the founder's
language. Reserved slots are not free capacity. A failed read means capacity
could not be verified; it does not mean zero allowance or disconnection.
Never bypass reservations through retries, dry runs or manual inserts.
Exhausted discovery allowance limits new acquisition, not reviewing saved
evidence, connecting accounts, or drafting requested outreach.
