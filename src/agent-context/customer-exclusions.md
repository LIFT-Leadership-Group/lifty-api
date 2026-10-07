# Customer exclusions

Use this stage when the founder asks to protect existing customers or provides
a customer file. Read `references.common` in full. This works with or without
a connected CRM. Customer exclusions are optional. Connecting HubSpot or Attio
to receive leads does not authorize reading its customer data.

Read `source_choice_get` before offering this choice. `unselected` authorizes
no CRM customer reads. Ask once whether the founder wants selected CRM sources,
a customer file, or neither; save only their explicit answer with
`source_choice_post` and `expected_version` from the read. A saved `none`, `file`
or `crm` choice answers the question: do not offer it repeatedly. The founder
can change it later. An unavailable choice is unknown; retry the read without
assuming permission or requiring a choice to continue setup.

For `crm`, use the current provider (`hubspot` or `attio`) and only the sources
the founder authorizes: `crm_closed_won` (companies on won deals),
`crm_customer` (HubSpot companies flagged as customers), or `crm_open_deal`
(companies with open deals). Choose each once. Attio has no customer flag.
For `file` or `none`, send a null provider and an empty sources list. Include
the current version even when it is 0. On `CUSTOMER_SOURCE_CHOICE_MOVED`, read
again and save only the intended answer. After a lost response, read the choice
before retrying. `refresh_pending` means a durable refresh is waiting; it does
not prove the customer list is current.

File-only and neither allow activation and new Journey starts without CRM
freshness checks. With neither, explain that unknown existing customers will
not be protected. Saved customer exclusions and do-not-contact protections
remain enforced in every mode. Turning CRM reads off preserves the last saved
list. A file can complement an enabled CRM source: importing does not grant
CRM access, disable CRM sources, or change the saved choice. Removing imported
customers remains a separate explicit import action.

Read `status` before an import. It separates total saved domain/email counts
from the founder-uploaded counts. It also shows the latest founder import
revision, accepted rows, rejected rows with reasons, the previous import's
added/removed counts and the number of candidates excluded. Saved
domain counts include CRM and manual protections. An unavailable status is
unknown; retry the read before reporting that there are no customers saved.

`status` also returns `source_choice`, independently of the CRM connection,
and `crm_refresh`: freshness of enabled CRM customer sources. A null
`source_choice` could not be read and is unknown. `fresh` means required sources refreshed recently.
`stale` means the last saved list still applies but has not refreshed in over
two days. `missing` means a required CRM source (for example closed-won deals)
has never been read, so the customers it holds are not excluded.
`not_required` means no enabled required CRM source needs this check. `reason`
names the cause, for example `closed_won_stage_not_found` (an Attio deal pipeline without its won stage),
`hubspot_deals_read_scope_missing`, `provider_failed` or `crm_disconnected`;
`sources` shows each CRM source's last attempt and last success. `fresh` covers
only the sources marked `required`: Attio supplies no customer flag, so an
Attio workspace is protected by its closed-won deals only, and a customer who
never had a closed-won deal needs the customer file. Saved protections from a
source that is fresh still apply when another source is missing. An enabled,
connected required source that is missing, stale or loses credentials holds
activation changes and new Journey starts; started Journeys continue. Explain
the reason and repair that source. Do not silently change the founder's choice
to clear a failure. They can explicitly choose file-only or neither instead.
A disconnected CRM continues on its last saved list and alerts; it does not
hold outreach. Structurally unavailable sources are report-only. Connecting
or reconnecting queues a refresh only for enabled, authorized sources, even
when the saved list is fresh; it never resumes outreach.
Never say connecting alone protects CRM customers. Only the enabled sources
marked `required` and reported `fresh` have current CRM protection.
A null `crm_refresh` could not be read: it is unknown, not fresh.

The CSV needs a `domain`, `company_domain` or `website` column, an `email`
column, or both. `Company Domain`, `Company Website`, `Email Address`,
`Person Email` and `Customer Email` are also accepted. Names and other columns
are ignored. Use UTF-8, at most 128 KiB, 5000 data rows, 32 columns and 10000
distinct customer identities. Quoted commas and line breaks are supported.
Row numbers count CSV records, starting with the header at 1. Blank lines are
ignored; a quoted empty customer record is rejected.

Import with `lifty post customer-exclusions import --csv-file <path>`, or send
`{"csv":"<CSV text>"}` as the operation body. Explain that this replaces the
complete founder-uploaded list: customers absent from the new file lose their
upload protection. CRM and manual protections stay. Import only the file the
founder chose; do not infer customer status or add guessed companies.

Company domains deduplicate case, scheme, trailing-dot and `www` variants.
Domain matching uses the exact saved company domain; it does not infer parent
companies or subsidiaries. Emails match the exact person after normalization
to lowercase. An email alone never suppresses its entire company. Free-mail
hosts such as Gmail never suppress the whole host; include that customer's
exact email. A row with an invalid domain or email is rejected in full. A
free-mail domain with a valid email keeps the email. Rejected rows contain
their record number and reason; private cell values are not echoed.

Report the saved domain/email totals, accepted rows, rejected rows and the
founder-upload added/removed counts from the import receipt. Removed upload
membership can still have CRM or manual protection. Duplicate valid records count
as accepted rows but create one saved identity. To clear the founder list,
the founder can choose a CSV containing only its recognized header. A broken
header or an unclosed quoted field rejects the file before changing anything.
A file whose customer rows are all rejected also preserves the saved list;
repair that file instead of treating it as permission to clear protection.

After a lost response, read `status` and compare its revision before retrying
the same file. Retrying the same normalized content and rejection report is
idempotent. Importing does not acquire leads, restart research, connect a CRM
or send outreach. The exclusion count records discoveries already prevented;
the saved-list read alone does not acquire more people to prove protection.
