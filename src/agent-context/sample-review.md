# Sample review

Purpose: inspect the existing bounded lead cohort against confirmed targeting.
Read `references.common` and `references.calibration` in full.

## Read current state

GET returns the existing run, actual grades, evidence/links and its calibration
policy. It does not invent a review result or return a persisted approval state.
Preserve historical policy and grades; old cohorts are not new research.

## First setup and required inputs

After setup is imported, POST has an empty object body and reuses the existing bounded first-run
operation. It starts/retrieves the initial cohort; it does not repeatedly buy
new leads until a desired grade appears. Use the returned `run_ref` with
`sample-review.progress` while work is pending. The first read returns immediately;
pass its `cursor` and `wait_seconds: 25` on the next call to wait for a change.
Keep one request open at a time. Report newly researched people as they appear,
then present the actual cohort when `terminal` is true. Do not sleep for two
minutes or POST again just to check progress.

Each progress response is the complete current cohort (at most 25 people).
`changed: false` means no change during that wait; reuse the cursor. Reconnect
with the same run reference and last cursor. Deduplicate narrated completions
by `run_ref`, `attempt` and `lead_ref`; a new attempt resets that comparison.
Research can become superseded, so retain the returned current snapshot rather
than adding counts from responses. These are observations of saved state, not
a persisted event history: intermediate changes can be coalesced, and partial
research may already exist when an attempt resumes. Preserve every actual grade.

A failed run is terminal; a read error is not. Retry a failed read with the same
run and cursor, never start discovery or research recovery automatically. Stop
waiting on terminal success/failure, cancellation, or a founder change of task.
Host tools may buffer output; Lifty returns progress as changes are observed,
but cannot guarantee the host narrates each lead in real time.

## Later edits

PATCH is unsupported (405): no grade editing, new sample approval store or
persisted stage ledger. A targeting/rubric change goes through its own stage.
When several people were disqualified for the same reason a search filter can
express (industry, company size, location), propose that Targeting filter so
research is not spent on people who cannot fit; evidence-only reasons stay in
the research criteria.
Founder acceptance stays a conversation decision; never claim it was saved as
a new product feature. A saved shortfall requires diagnosis before more work.

## User-facing behavior and errors

For `researched_v1`, all five researched profiles count regardless of tier,
including C. Three A, one B and one C is a complete sample, as is an all-C
cohort with complete evidence. Show person, company, actual grade, LinkedIn
profile URL, fit rationale and evidence gaps. Readiness to review is distinct
from targeting quality, founder acceptance and outreach eligibility.

Preserve historical policies and actual grades. An explicit POST retry of a
failed `tier_a_v1` or `qualified_ab_v1` run adopts the current review policy
using its saved cohort. Do not acquire replacements to chase A/B grades.
Missing current research, a valid profile or rationale still needs recovery;
`calibration_sample_incomplete` reports that evidence gap. Respect allowance.
A status error is not a failed
run. No new discovery is required merely to connect an account or draft outreach
with chosen saved leads; exact sending approval remains separate.

## After sample acceptance

"Looks good" after the lead table accepts the sample only. When the founder
continues toward outreach, fetch `context campaigns`. If channel intent is
missing, offer LinkedIn, email, both, or not right now and wait. Do not recommend
email simply because a mailbox is connected. Follow the campaign context to
explain the chosen sequence before configuring outreach. Reuse explicit choices;
never turn sample acceptance into campaign activation consent.

In a later session `next_step` returns this stage while no campaign is saved.
The saved cohort is ready to use: do not present it as new work or ask for a
second review unless the founder wants one. A "not right now" answer about
outreach is not saved, so ask about it at most once per session and accept it.

## Exact failed-run recovery

Recovery reads and writes belong to this research stage. recovery_status reads
the selected workspace and first-run references. recovery request verifies that
the current acquisition is terminal; it does not restart it. An explicit restart
requires the current expected_acquisition_ref, authoritative verified status and
the founder's request. Keep the durable attempt and historical budget; lost
wakeups are recovered with the same exact references. Pending is not completion.
Never use repeated first-run POSTs to bypass active acquisition or consumed limits.
