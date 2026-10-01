# Targeting

Read every saved search lane. Targeting owns the people/company search filters and stable personas. Use neutral fields from the operation schema; apply known exclusions as search filters before research costs budget. NAICS industry_codes and excluded_industry_codes use the public 2–6 digit standard; validate codes against the official NAICS reference at https://www.census.gov/naics/ . Personas have stable id, name, titles and optional persona_type; their role and organizational tell belong to setup criteria inputs.

PATCH lanes by id and expected_version. Only supplied fields change, including partial company fields; preserve every omitted lane/filter, NAICS code and domain. Allocation and data-quality knobs are platform policy. Employees supports a simple min/max range or ordered non-overlapping ranges for existing searches. Null clears a filter. Changed filters affect the next discovery, and already found people remain deduplicated.

A persona change needs explicitly regenerated_criteria with its expected version and source versions in the same request; both writes are atomic. Filter edits regenerate nothing. After calibration, when evidence repeatedly disqualifies people for a filterable reason, propose the relevant filter and explain why it avoids wasted research. Initial creation belongs to setup; targeting is never deleted or activated here.
