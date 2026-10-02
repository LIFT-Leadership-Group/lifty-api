import { describe, expect, it } from "vitest";
import { CampaignCreateSchema, JourneyPolicySchema, CampaignDraftSchema } from "../src/outreach-contracts.js";
import { policy, senderId, campaignRef, journeyRef, journeyPolicy, revisionRef } from "./outreach-fixtures.js";
const create = (channel: string, value: unknown) => CampaignCreateSchema.safeParse({ name: "Campaign", journey_ref: journeyRef, channel, policy: value });
const email = { ...policy, start: [{ type: "sent", campaign_ref: campaignRef, step: 2, after: { business_days: 2 } },
  { type: "unaccepted", campaign_ref: campaignRef, after: { business_days: 5 } }],
  steps: Array.from({ length: 4 }, (_, i) => ({ position: i + 1, delay: { days: i ? 3 : 0 } })) };
const lanes = { field: "title", rules: [{ lane: "transform", contains_any: ["transform", "change", "automation"] }], default: "ops" };
const laned = (openers = true) => ({ ...email, compose_mode: "templates", lanes, steps: email.steps.map(step => ({ ...step,
  variants: ["transform", "ops"].flatMap(lane => (step.position === 1 && openers ? ["cold", "linkedin_bridge"] : [undefined]).map(opener => ({
    lane, ...(opener ? { opener } : {}), ...(step.position === 1 ? { subject: `${lane} thread` } : {}), text: `${lane} ${step.position}` }))) })) });
describe("supported Outreach policy boundary", () => {
  it("Campaigns own their start rules, generated instructions or one template per step", () => {
    expect(create("linkedin", { ...policy, sender_ids: [senderId, campaignRef] }).success).toBe(true);
    expect(create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hello {first_name}" } }] }).success).toBe(true);
    expect(create("linkedin", { ...policy, compose_mode: "templates" }).success).toBe(false);
    expect(create("linkedin", { ...policy, start: [] }).success).toBe(false);
    expect(create("email", { ...email, start: [{ type: "journey_start" }, email.start[0]] }).success).toBe(false);
    expect(create("email", { ...email, start: [email.start[0], email.start[0]] }).success).toBe(false);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { instructions: "Changed only this" } }).success).toBe(true);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { lanes: null } }).success).toBe(true);
  });
  it("exposes only supported sequence counts and receipt delays; the saved sequence owns the count", () => {
    expect(create("email", email).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.slice(0, 3) }).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, delay: { business_days: step.position === 1 ? 0 : 3 } })) }).success).toBe(false);
    expect(create("linkedin", email).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map((step, i) => ({ ...step, delay: { days: i ? 31 : 0 } })) }).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, execute_within: { days: 3 } })) }).success).toBe(false);
  });
  it("title lanes and first-email openers: one variant per lane and opener, one thread subject per lane", () => {
    expect(create("email", laned()).success).toBe(true);
    expect(create("email", laned(false)).success).toBe(true);
    const missing = laned(); missing.steps[1]!.variants = missing.steps[1]!.variants.slice(0, 1);
    expect(create("email", missing).success).toBe(false);
    const lateOpener = laned(); lateOpener.steps[2]!.variants = lateOpener.steps[2]!.variants.map(v => ({ ...v, opener: "cold" }));
    expect(create("email", lateOpener).success).toBe(false);
    const laterSubject = laned(); laterSubject.steps[1]!.variants = laterSubject.steps[1]!.variants.map(v => ({ ...v, subject: "New thread" }));
    expect(create("email", laterSubject).success).toBe(false);
    const splitThread = laned(); splitThread.steps[0]!.variants[1] = { ...splitThread.steps[0]!.variants[1]!, subject: "Another thread" };
    expect(create("email", splitThread).success).toBe(false);
    expect(create("email", { ...laned(), compose_mode: "generate" }).success).toBe(false);
  });
  it("Journey holds only the audience and shared stops; no graph or timing", () => {
    expect(JourneyPolicySchema.safeParse(journeyPolicy).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "qualified", tier: "A" } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "static", lead_refs: [senderId] } }).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, graph: { entries: [] } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, stops: ["reply"] }).success).toBe(false);
    expect(create("linkedin", { ...policy, schedule: { ...policy.schedule, timezone: "not-a-zone" } }).success).toBe(false);
    expect(create("linkedin", { ...policy, provider: "hidden" }).success).toBe(false);
  });
});
