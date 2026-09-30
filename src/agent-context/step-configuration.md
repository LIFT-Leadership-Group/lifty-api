# Section 1 · Build and submit the search

Goal: turn the confirmed draft into the search configuration, submit it once
and follow the import. Do `actions` from `next_step` in order.

1. Tell the founder in one line that you are building their search and
   research rules now.
2. Read `targeting_onboarding_context`. Its `generation_rules`,
   `configuration_schema` and `context_version` govern the artifact.
3. Generate `icp_config` and `scout_overlay` from the whole saved draft using
   `references.configuration`. Copy `contract_version` and `context_version`
   unchanged; never edit a fingerprint.
4. Save the unchanged draft with the configuration through
   `business_onboarding_save` and the latest `expected_revision`.
5. Submit once with `targeting_post`: `draft`, `configuration`, the
   `expected_revision` returned by that save, and one stable `idempotency_key`
   you keep (reuse the saved key when the state already has one).
6. Read `targeting_onboarding_status` every few seconds until `imported` or
   `failed`. Never POST again to check progress. After a lost response, read
   status and recover with the original key and content only.
7. When imported, share the confirmed target in plain words (two to four
   lines) and call `next_step`: the lead search is next.

A definite validation rejection lists paths and messages: repair technically
at most three times, regenerating from fresh context. Ask the founder only for
missing business intent. A read error means the outcome is unknown, not
failed. Full repair rules: `summary_context` with task `targeting`.
