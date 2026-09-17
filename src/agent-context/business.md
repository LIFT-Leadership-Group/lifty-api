# Business

Purpose: establish which business the founder is configuring and preserve its
confirmed description. Read `references.common` first.

## Read current state

Use `operations.get`. It returns workspace existence and the saved workspace
configuration, or null configuration before provisioning. Use the actual
name/description and `website.value.website_url` when available; never ask for an already saved value again.

## First setup and required inputs

POST provisions the authenticated founder's workspace with required `name`
and optional nullable `description` and `website_url`. Save the primary URL
when the founder supplies or confirms it, including during first setup. Explain the proposed name/description
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

## Saved website

GET exposes `website` separately from the legacy configuration. An available
null `website_url` means no confirmed primary site; unavailable means retry the
read, not ask the founder to provide it again. Research `candidates` retain
useful onboarding sources but are never confirmed choices. Offer those known
URLs for confirmation instead of claiming no site was saved anywhere.

To save a confirmed primary URL, PATCH `section: website`, `values: {website_url}`
and the current website `expected_version`. Explicit null clears the confirmed
URL. This update is immediate and changes no campaign copy or sending status.
Name/description edits still use `section: workspace`; do not combine them with
a website edit. If the version is stale or the write outcome is uncertain, GET
and reconcile the saved URL before retrying. No research URL is auto-promoted.
