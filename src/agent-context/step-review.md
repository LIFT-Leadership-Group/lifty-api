# Section 1 · Review the leads, sync the CRM, close the section

Goal: the founder sees real leads, tunes the target if needed, optionally gets
them into HubSpot, and leaves Section 1 knowing what was done and what comes
next. Do `actions` from `next_step` in order; skip what the conversation has
already covered.

## 1. Show the leads

Use the finished cohort (`sample_review_get` if it is not already in this
conversation). Open with your read: the strongest lead and the pattern across
the five. Then a table: person, company, grade, LinkedIn profile URL, fit
rationale, evidence gaps. Every researched profile counts, including C; say
why lower-fit leads missed. Use only returned profile URLs.

## 2. Tune the target

Ask one question: does this sample confirm the targeting, or what should
change? A change clarifies only the affected decision, then follows
`summary_context` task `targeting` or `research-criteria` (synchronous versioned PATCH,
readback) and reruns the sample. Never relabel grades, widen the
market or invent fit. When several leads missed for the same reason a search
filter can express (industry, company size, location), propose that Targeting
filter: research costs time and budget, and the filter keeps it on people who
can fit. `references.calibration` covers diagnosis.

## 3. CRM (optional)

Follow the CRM action in `actions`; ask about it once. Only HubSpot connects
here; for another CRM say it is not supported yet and continue.

- Connect: `crm_post`, show the returned link right away as a Markdown link,
  and after the founder finishes, `crm_get` with that `attempt_ref`. Only
  `connected` with `verified: true` confirms it.
- Company setup before the first sync: `crm_mapping_context`; if it is not
  ready, prepare the bounded plan per `references.company_mapping` and apply
  it with `crm_patch`.
- Sync: `crm_sync_start`, then `crm_sync_status` for that `run_ref` until it
  finishes. Report contacts, research notes and companies delivered
  separately; partial delivery is not full success.

## 4. Close Section 1

Once the founder is happy with the leads (and the CRM question is answered),
close the section in at most six lines: who Lifty targets and why, the five
leads and their grade mix, what reached HubSpot, and that Lifty can keep
finding leads like these. Then ask one question: set up LinkedIn outreach for
these leads now? LinkedIn goes first; email comes later, once a mailbox is
ready. If yes, read `summary_context` task `campaigns`. If "not now", accept
it and do not ask again this session.

Section 1 never sends messages or activates outreach, and sample acceptance is
not saved anywhere: do not claim it was.
