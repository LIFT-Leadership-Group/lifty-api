# Campaigns

Each channel campaign owns its saved sequence, templates or generation instructions, internal receipt-relative delays and local sending schedule/timezone. Business owns profile/voice revisions; Identity owns named senders and accounts; Searches owns lead facts. No vendor, engine, language, country or rate-control field belongs here.

Read before editing. Create an inactive unapproved draft; attach it through a separate journey draft edit. Permit canonical sender_ids without imposing one sender per campaign. One lead retains the same immutable named person across LinkedIn and email; account shortage never transfers that lead to another person.

Draft edits require resource expected_version and exact source revision_ref, change supplied policy fields only, and append an immutable unapproved successor. The current active binding and approved work continue. Editing while paused/blocked cannot release intent/readiness/incident holds. The sequence owns its count and delays; current adapter bounds are LinkedIn one to three messages after its invitation, email four or five steps with calendar-day delays.

Publish approves only the chosen exact revision/digest and records actor/time. Separately activate with campaign and journey expected_version to replace only this campaign's future-start pin in the journey binding and set its intent. Use activate after pause too; there is no resume alias. A journey binding must already exist: activate an exact approved journey/campaign combination first. Sibling pins and all started runs keep their versions, content, sender, signature, account/thread and timing.

Pause prevents beginning every automatic step, including follow-ups, retaining pending work and reconciling begun/unknown effects. Other channels continue where the saved graph permits. Connection/readiness/approval cannot activate intent. Intent is not proof of dispatch or account readiness.

Generation and templates are supported saved policies. Templates mode requires every step's saved template; generated mode uses instructions. Full sender signature is included before preview/approval; approved bytes retain it. Waits run from actual prior confirmed send, not preparation or enrollment, and account availability never compresses delays or expires queued work.

Queue a saved test with tests_post using exact revision_ref/digest/expected_version, an idempotent request_ref, and at most 20 explicit researched lead_refs. Preview person selection uses existing allocation rules without assigning the lead; it is saved provenance only. For a comparison, supply baseline_test_ref from a completed test: retain those exact sample facts/person and historical signed before outputs, compose only the candidate after, and disclose context_changes. tests_get discovers accepted receipts after a lost response; test_detail reads outputs and baseline_output_ref. Read the referenced baseline test to compare saved bytes. A queued/running receipt is not completed output, approval or sending permission.

For an actual still-unapproved per-lead draft, message_get reads the real message_ref; message_revisions_post corrects its exact source_digest and expected review state into a new pending message_ref. Preserve the original bytes, person/signature and template/prompt/library/selection provenance; the existing reviewer approval path applies to the returned new row. Approved, sent, superseded or missing-signature-pin sources cannot be corrected through this action. It never approves or sends. An idempotent retry may read back that same replacement after its reviewer state has advanced.

The runtime read derives admitted, continuing, prepared and pending run counts grouped by exact binding/revision, plus only recorded gate reasons. Older started bindings remain visible. Intent is separate; missing recorded reasons do not prove readiness. Unknown reads stay unavailable.

Read back after uncertain writes; never repeat creation/approval/activation blindly. Unknown state is unavailable, not inactive/empty/failed/healthy. references.writing and references.anti_slop guide draft copy; references.common owns transport.
