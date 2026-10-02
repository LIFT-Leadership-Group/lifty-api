export const journeyRef = "11111111-1111-4111-8111-111111111111";
export const campaignRef = "22222222-2222-4222-8222-222222222222";
export const revisionRef = "33333333-3333-4333-8333-333333333333";
export const senderId = "44444444-4444-4444-8444-444444444444";
export const workspace = { workspace_ref: "55555555-5555-4555-8555-555555555555", name: "Example", state: "ready_for_connections" };
export const digest = "a".repeat(64);
export const policy = { steps: [{ position: 1, delay: { business_days: 0 } }], compose_mode: "generate", instructions: "Use saved research.",
  schedule: { timezone: "America/Argentina/Buenos_Aires", weekdays: [1,2,3,4,5], start: "09:00", end: "17:00" },
  profile_version: 1, voice_version: 0, sender_ids: [senderId] };
export const journeyPolicy = { audience: { kind: "qualified" }, graph: { entries: [{ campaign_ref: campaignRef, trigger: { type: "start" } }],
  stops: ["reply", "meeting_booked", "suppression", "manual_stop"] } };
export const revision = (content: unknown, approved = false) => ({ revision_ref: revisionRef, digest, content, created_at: "2026-10-02T12:00:00Z",
  approval: approved ? { actor_ref: senderId, approved_at: "2026-10-02T13:00:00Z" } : null });
export const binding = { binding_ref: senderId, digest, journey: { revision_ref: revisionRef, digest }, campaigns: [{ campaign_ref: campaignRef, revision: { revision_ref: revisionRef, digest } }] };
export const journey = { journey_ref: journeyRef, version: 1, name: "Journey", active_binding: null, draft_revision: revision(journeyPolicy), revisions: [revision(journeyPolicy)] };
export const campaign = { campaign_ref: campaignRef, journey_ref: journeyRef, channel: "linkedin", version: 1, name: "LinkedIn", state: "paused",
  effective_revision: null, draft_revision: revision(policy), revisions: [revision(policy)] };

export const campaignSummary = { campaign_ref: campaign.campaign_ref, journey_ref: campaign.journey_ref, channel: campaign.channel, version: campaign.version,
  name: campaign.name, state: campaign.state, effective_revision: null, draft_revision: { revision_ref: revisionRef, digest, approval: null } };
export const journeySummary = { journey_ref: journey.journey_ref, version: journey.version, name: journey.name, active_binding: null,
  draft_revision: { revision_ref: revisionRef, digest, approval: null } };
