# Sample review

Purpose: inspect the existing bounded lead cohort against confirmed targeting.
Read `references.common` and `references.calibration` in full.

## Read current state

GET returns the existing run, actual grades, evidence/links and its calibration
policy. It does not invent a review result or return a persisted approval state.
Preserve historical policy and grades; old cohorts are not new research.

## First setup and required inputs

After configuration is imported, read the capacity stage before new discovery.
POST has an empty object body and reuses the existing bounded first-run
operation. It starts/retrieves the initial cohort; it does not repeatedly buy
new leads until a desired grade appears. Read GET until the operation reaches
a confirmed state, then present the actual cohort.

## Later edits

PATCH is unsupported (405): no grade editing, new sample approval store or
persisted stage ledger. A targeting/rubric change goes through its own stage.
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
explain the chosen sequence before writing templates. Reuse explicit choices;
never turn sample acceptance into campaign activation consent.
