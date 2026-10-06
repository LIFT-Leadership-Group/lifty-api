# Customer exclusions

Use this stage when the founder asks to protect existing customers or provides
a customer file. Read `references.common` in full. This works with or without
a connected CRM. next_step offers it at the sample review, with the CRM
question, when no CRM is connected (a connected HubSpot or Attio already
excludes the companies in its deals and closed customers). The founder can
skip it then and add or replace the file any time.

Read `status` before an import. It separates total saved domain/email counts
from the founder-uploaded counts. It also shows the latest founder import
revision, accepted rows, rejected rows with reasons, the previous import's
added/removed counts and the number of candidates excluded. Saved
domain counts include CRM and manual protections. An unavailable status is
unknown; retry the read before reporting that there are no customers saved.

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
