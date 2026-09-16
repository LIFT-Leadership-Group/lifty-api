# Business

Purpose: establish which business the founder is configuring and preserve its
confirmed description. Read `references.common` first.

## Read current state

Use `operations.get`. It returns workspace existence and the saved workspace
configuration, or null configuration before provisioning. Use the actual
name/description when available; never ask for an already saved value again.

## First setup and required inputs

POST provisions the authenticated founder's workspace with required `name`
and optional nullable `description`. Explain the proposed name/description
using the founder's confirmed business information. A workspace already linked
to this account is a reason to read it, not to create another one.

## Later edits

PATCH uses `section: workspace` and `values` containing only confirmed name
or description changes. Preserve unrelated configuration. These direct edits
do not require locally generating an ICP/research artifact. Read back the
business stage and confirm the saved text.

## User-facing behavior and errors

Explain what the business does and what changed, not its internal identifiers.
The daily discovery target displayed in workspace configuration is read-only;
use the capacity stage to inspect it. Do not patch capacity, workspace ownership,
suspension or membership. For ambiguous/suspended workspace responses, stop
and explain the account/workspace restriction; do not choose another tenant.
After an uncertain edit, GET the saved business values before retrying. If a
submission receipt was returned, check that exact receipt with update_status.
The generated-configuration resolve operation does not apply to metadata edits.
