import { describe, expect, it } from "vitest";
import { CampaignCreateSchema, JourneyPolicySchema, CampaignDraftSchema } from "../src/outreach-contracts.js";
import { policy, senderId, campaignRef, journeyRef, journeyPolicy, revisionRef } from "./outreach-fixtures.js";
const create = (channel: string, value: unknown) => CampaignCreateSchema.safeParse({ name: "Campaign", journey_ref: journeyRef, channel, policy: value });
describe("supported Outreach policy boundary", () => {
  it("supports generated instructions and exact template sequences without selecting a person per campaign", () => {
    expect(create("linkedin", { ...policy, sender_ids: [senderId, campaignRef] }).success).toBe(true);
    expect(create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hello {{first_name}}" } }] }).success).toBe(true);
    expect(create("linkedin", { ...policy, compose_mode: "templates" }).success).toBe(false);
    expect(create("linkedin", { ...policy, steps: [{ position: 1, delay: { days: 0 }, template: { text: "Unexpected" } }] }).success).toBe(false);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { instructions: "Changed only this" } }).success).toBe(true);
  });
  it("exposes only supported sequence counts and receipt delays, without a second graph sequence owner", () => {
    const email = { ...policy, steps: Array.from({ length: 4 }, (_, i) => ({ position: i + 1, delay: { days: i ? 3 : 0 } })) };
    expect(create("email", email).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.slice(0, 3) }).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, delay: { business_days: 0 } })) }).success).toBe(false);
    expect(create("linkedin", email).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map((step, i) => ({ ...step, delay: { days: i ? 31 : 0 } })) }).success).toBe(false);
    expect(create("email", { ...email, steps: [...email.steps, { position: 5, delay: { days: 0 } }] }).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, execute_within: { days: 3 } })) }).success).toBe(false);
  });
  it("consumes qualification without tier aliases and rejects foreign graph syntax and duplicated timing", () => {
    expect(JourneyPolicySchema.safeParse(journeyPolicy).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "qualified", tier: "A" } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "static", lead_refs: [senderId] } }).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, graph: { ...journeyPolicy.graph, entries: [{ campaign_ref: campaignRef, trigger: { type: "sent", campaign_ref: senderId, step: 1, after: { days: 2 } } }] } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, graph: { ...journeyPolicy.graph, delivery_specs: {} } }).success).toBe(false);
    expect(create("linkedin", { ...policy, schedule: { ...policy.schedule, timezone: "not-a-zone" } }).success).toBe(false);
    expect(create("linkedin", { ...policy, provider: "hidden" }).success).toBe(false);
  });
});
