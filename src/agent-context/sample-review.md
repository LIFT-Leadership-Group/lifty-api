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

For `qualified_ab_v1`, five eligible A/B profiles fill the review sample; C
never counts. A B-only sample needs explicit acceptance or refinement. Show
person, company, actual grade, LinkedIn profile URL, fit rationale and evidence
gaps. Retain the historical A-only rule for older/unknown policies.
Respect allowance and calibration-review stops. A status error is not a failed
run. No new discovery is required merely to connect an account or draft outreach
with chosen saved leads; exact sending approval remains separate.
