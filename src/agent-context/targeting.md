# Targeting / ICP

Purpose: translate confirmed buyer and company criteria into supported
discovery fields. Read `references.common`, `interview` and `calibration`.

## Read current state

GET reads the saved ICP/personas. Read `generation_context` before edits to
obtain current configuration, confirmed draft, generation rules and artifact
schema. Existing values answer questions; shared schemas do not.

## First setup and required inputs

Obtain only missing company, buyer, geography, size/unit, persona and exclusion
decisions described by the current draft schema. Read `onboarding_context` and
generate the configuration locally against its current schema. Stage POST
uses the existing full onboarding submission (`draft` and `configuration`),
once for the initial setup; it is not a partial-stage write. Research criteria
and commercial voice share that initial transaction. Use `lifty submit targeting`
as described in `references.configuration`: it checks bound artifacts, preserves
the exact request/receipt, follows `onboarding_status` and GETs saved targeting.
Resume that receipt with `--resume`; do not repeat the POST per stage.

## Later edits

PATCH uses `section: icp`, changed `values`, and the locally generated
`configuration` required by the authenticated generation contract. Supported
criteria are person/company locations, industries, employee ranges, seniorities,
personas, generic keywords, email status, staleness and extrapolation settings.
Use the runtime schema/rules for exact fields. Persona lists replace the full
list, so preserve confirmed personas when changing filters only. Confirm the
applied receipt and read back saved targeting before reviewing a new sample.

## User-facing behavior and errors

Distinguish buyer geography from company headquarters. ARR/revenue is not
headcount; use an employee proxy only with founder agreement. Industry labels
do not prove native provider filtering; keywords are not Boolean search.
Explain any intentionally unrestricted native search before applying it.
Lane labels, allocation weights, versions and digests are read-only. Respect
multi-lane management restrictions and stale-context errors. Preserve unrelated
criteria and the A/B/C evidence rubric. A poor sample warrants diagnosis and a
confirmed adjustment, not repeated unchanged discovery or invented fit.
