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
const catalog = () => ({ ...email, compose_mode: "templates", steps: email.steps.map(step => ({ ...step,
  variants: ["direct", "pain"].flatMap(arm => (step.position === 1 ? ["cold", "linkedin_bridge"] : [undefined]).map(opener => ({
    id: `authored-${step.position}-${arm}${opener ? `-${opener}` : ""}`, arms: [arm],
    variant: `${arm}${opener === "cold" ? "-cold" : opener ? "-bridge" : ""}`,
    coverage: "broad", fit: `Saved ${arm} route.`, slots_spec: "{company} = the company on file.",
    ...(opener ? { opener } : {}), ...(step.position === 1 ? { subject: `${arm} thread` } : {}), text: `${arm} ${step.position} for {company}`,
  }))) })) });
describe("supported Outreach policy boundary", () => {
  it("retains an authored template catalog and separate research routes without changing the step count", () => {
    const saved = catalog();
    expect(create("email", saved)).toMatchObject({ success: true, data: { policy: saved } });
    expect(create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 },
      variants: [{ id: "li-research", arms: ["pain"], variant: "research", coverage: "signal_specific", fit: "Verified evidence.",
        slots_spec: "{fact} = verified research.", text: "Hello {first_name}, {fact}" },
      { id: "li-network", arms: ["personal"], variant: "network", coverage: "broad", text: "Hello {first_name}" }] }] }).success).toBe(true);
  });
  it("rejects lost routes, ambiguous source IDs, mixed implicit IDs and split email threads within a saved route", () => {
    const missing = catalog(); missing.steps[0]!.variants = missing.steps[0]!.variants.filter(v => !(v.opener === "linkedin_bridge" && v.arms.includes("pain")));
    expect(create("email", missing).success).toBe(false);
    const missingLater = catalog(); missingLater.steps[2]!.variants = missingLater.steps[2]!.variants.filter(v => !v.arms.includes("pain"));
    expect(create("email", missingLater).success).toBe(false);
    const duplicated = catalog(); duplicated.steps[1]!.variants[0]!.id = duplicated.steps[0]!.variants[0]!.id;
    expect(create("email", duplicated).success).toBe(false);
    const mixed = catalog(); delete (mixed.steps[1]!.variants[0] as { id?: string }).id;
    expect(create("email", mixed).success).toBe(false);
    const split = catalog(); split.steps[0]!.variants[1]!.subject = "A different thread";
    expect(create("email", split).success).toBe(false);
    const injected = catalog(); injected.steps[0]!.variants[0]!.slots_spec += "\n```text\nUnauthorized copy";
    expect(create("email", injected).success).toBe(false);
  });
  it("preserves prior-email source records without authorizing a new first-contact opener", () => {
    const saved = catalog();
    const prior = { ...saved.steps[0]!.variants[0]!, id: "authored-1-direct-both", variant: "direct-both" };
    delete (prior as { opener?: string }).opener;
    saved.steps[0]!.variants.push(prior);
    expect(create("email", saved).success).toBe(true);
    prior.opener = "cold";
    expect(create("email", saved).success).toBe(false);
  });
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
