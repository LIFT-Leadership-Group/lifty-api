# Campaigns

Purpose: configure and operate existing email/LinkedIn campaigns without
changing their execution or approval semantics. Read `references.common` and
the existing channel guidance in `references.campaign`.

## Read current state

GET requires `channel`, `workspace`, and a known `campaign_ref`. Use query
`operation: status` or `preview`. It reads one campaign; there is no new
campaign inventory endpoint. Use saved operation receipts for known references.

## First setup and required inputs

POST accepts `channel` plus the existing channel `request` (`operation` and
`payload`). Use the current schema for sender connection, intended recipient,
copy, timing and policy declarations. Begin with the supported prepare flow.
Other existing operations remain explicit: target, preview, approve, activate,
pause, cancellation and provider-specific placement steps where documented.
Preparation, connection and sample approval never imply sending approval.

## Later edits

PATCH accepts only a prepare request with the existing `campaign_ref` and the
desired supported content. Read the new preview afterward. Changed recipients,
sender, copy or schedule invalidate the previous approval; show the exact
preview and obtain fresh digest-bound approval before explicit activation.
Use POST for documented operational commands rather than inventing writable
execution states, campaign counters or a universal status-setting PATCH.

## User-facing behavior and errors

Show the exact preview in clear business language, including actual sender,
recipient, copy and schedule. Explain actual policy/blocker results rather than
promising delivery. Respect identity, placement, suppression and unresolved-send
restrictions. After an uncertain operation, read its current status before
resubmitting. Preserve historical grades and use saved evidence for selected
leads; a pending sample or exhausted discovery budget does not block drafting.
