# Business setup

The workspace server draft is the only source. Create and confirm the commercial profile first. Read the draft before asking and save each confirmed block with expected_version. Draft contains neutral targeting, criteria_inputs and evidence; no duplicate company facts, outreach status or lead-volume knobs.

Ask only the next missing gate. Motion needs name and why_now. Market needs lanes/personas and a meaningful filter. Exclusions require an explicit disqualifiers list; empty means no evidence-based exclusions and is valid. Boundaries need operating_state and explicit parked_motions; an empty parked list is valid. Every persona id needs role and tell. Do not invent exclusions just to satisfy a gate.

Read generation_context for the actual current Scout base, confirmed profile, draft and API schemas/rules. Generate only criteria, then save generated_criteria with current profile_version/base_version and the resulting draft_version (expected_version+1). Never translate targeting into a second local artifact or fingerprint versions yourself.

Submit expected_draft_version once. The transaction creates Targeting and criteria together at version 1 and returns an imported receipt with setup_ref and exact versions. Same version replays that receipt. Lost response: read status; a failed read means unknown. Changed sources need fresh context/generation. Another setup version cannot overwrite an existing setup.

Discard the draft with DELETE only before submission; after submission it is immutable history. Later edits use each resource's PATCH. Saving/submitting does not activate recurring research, CRM sync or outreach. Use next_step to resume the existing checkpoint ids.
