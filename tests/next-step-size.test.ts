import { describe, expect, it } from "vitest";
import { getAgentContext } from "../src/agent-context.js";
import { NEXT_STEP_CATALOG, ON_REQUEST_CONTEXTS, getNextStep } from "../src/next-step.js";
import { operationToolNames } from "../src/operation-names.js";
import { stageOperations } from "../src/stage-contracts.js";
import { campaignSummary } from "./outreach-fixtures.js";
import { criteriaFixture, draftGetFixture, laneFixture, profileFixture, workspaceRef } from "./business-fixtures.js";

// Every next_step response is inlined into the founder's agent on each call;
// large ones stall chat connectors (LIF-1149). Limits per reason, in JSON
// characters, as the next_step test enforced before LIF-1173 (LIF-1295).
const limits: Record<string, number> = {
  workspace_missing: 25_000,
  workspace_suspended: 25_000,
  business_confirmation_needed: 25_000,
  confirmed_interview_needed: 25_000,
  configuration_needed: 40_000,
  configuration_saved: 12_000,
  setup_resource_unavailable: 12_000,
  sample_not_started: 12_000,
  sample_pending: 12_000,
  sample_failed: 12_000,
  sample_ready_for_founder_review: 40_000,
  campaigns_saved: 80_000,
};

const identity = { workspace_ref: workspaceRef, name: "Example", state: "ready_for_connections" };
const at = profileFixture.updated_at;
const run = { state: "succeeded", run_ref: "run-1", requested_leads: 5, leads_discovered: 5, leads_researched: 5,
  error_code: null, started_at: at, completed_at: at, workspace: { workspace_ref: workspaceRef, name: "Example" }, leads: [] };
const unset = { targeting: { workspace_ref: workspaceRef, targeting: null }, criteria: { workspace_ref: workspaceRef, criteria: null } };
const base = {
  business: { workspace: identity, profile: profileFixture } as unknown,
  targeting: { workspace_ref: workspaceRef, targeting: { version: 1, updated_at: at, lanes: [laneFixture] } } as unknown,
  criteria: { workspace_ref: workspaceRef, criteria: criteriaFixture } as unknown,
  setup: { workspace_ref: workspaceRef, state: "none" } as unknown,
  draft: draftGetFixture as unknown,
  run: { state: "none" } as unknown,
  campaigns: [] as unknown[],
};
const generated = { text: criteriaFixture.text, research_fields: criteriaFixture.research_fields,
  source_versions: { profile_version: 1, draft_version: 1, base_version: "base-v1" } };
const states: Partial<typeof base>[] = [
  { business: { workspace: null, profile: null } },
  { business: { workspace: { ...identity, state: "suspended" }, profile: profileFixture } },
  { business: { workspace: identity, profile: { ...profileFixture, confirmation: { complete: false, missing: ["offerings"] } } } },
  { ...unset, draft: { ...draftGetFixture, gates: { next: "persona", missing: ["persona"], issues: [] } } },
  unset,
  { ...unset, draft: { ...draftGetFixture, generated_criteria: generated } },
  { ...unset, setup: { workspace_ref: workspaceRef, state: "imported", setup_ref: "77777777-7777-4777-8777-777777777777",
    draft_version: 1, profile_version: 1, targeting_version: 1, criteria_version: 1, submitted_at: at } },
  {},
  { run: { ...run, state: "running", completed_at: null } },
  { run: { ...run, state: "failed", error_code: "search_exhausted" } },
  { run },
  { run, campaigns: [campaignSummary] },
];

async function nextStep(state: Partial<typeof base>) {
  const current = { ...base, ...state };
  const reads: Record<string, unknown> = { "business.get": current.business, "targeting.get": current.targeting,
    "research-criteria.get": current.criteria, "setup.status": current.setup, "setup.get_draft": current.draft };
  return getNextStep({
    businessOperation: async (_session, key) => reads[key],
    getRunStatus: async () => current.run,
    outreachOperation: async () => ({ workspace: identity, campaigns: current.campaigns, next_cursor: null }),
    getHubspotConnection: async () => ({ provider: "hubspot", status: "not_connected" }),
    getAttioConnection: async () => ({ provider: "attio", status: "not_connected" }),
    getCrmSyncStatus: async () => ({ state: "none" }),
  } as Parameters<typeof getNextStep>[0], { userId: "founder", client: {} } as Parameters<typeof getNextStep>[1]);
}

describe("next_step response size", () => {
  it("keeps every step within its limit and the full stage guide one read away", async () => {
    const seen = new Set<string>();
    for (const state of states) {
      const result = await nextStep(state);
      seen.add(result.reason);
      const size = JSON.stringify(result).length;
      expect(size, `${result.reason} is ${size} characters`).toBeLessThan(limits[result.reason]!);
      expect(getAgentContext(result.context_task!), result.reason).not.toBeNull();
    }
    expect([...seen].sort()).toEqual(Object.keys(limits).sort());
    expect(Object.keys(NEXT_STEP_CATALOG).sort()).toEqual(Object.keys(limits).sort());
  });
});

// The stage that owns each callable tool name.
const toolStage = new Map(Object.entries(stageOperations).flatMap(([stage, operations]) =>
  Object.keys(operations).flatMap(operation => operationToolNames(stage, operation).map(name => [name, stage] as const))));

// Each step tells the agent where to look; a context outside onboarding is
// declared with how the agent reaches it instead (LIF-1301).
describe("next_step context links", () => {
  it("links every stage context to a step or declares it on request", () => {
    const linked = new Set(Object.values(NEXT_STEP_CATALOG).flatMap(entry => [entry.context, ...entry.related]));
    for (const stage of linked) expect(Object.hasOwn(stageOperations, stage), `${stage} is not a stage`).toBe(true);
    for (const stage of Object.keys(ON_REQUEST_CONTEXTS)) expect(linked.has(stage), `${stage} is linked and declared on request`).toBe(false);
    expect([...linked, ...Object.keys(ON_REQUEST_CONTEXTS)].sort()).toEqual(Object.keys(stageOperations).sort());
  });

  it("recommends only tools of the stages the step links", async () => {
    for (const state of [...states, { run: { ...run, state: "failed", error_code: "research_limit_reached" } }]) {
      const result = await nextStep(state);
      expect(result.related_contexts, result.reason).toEqual(NEXT_STEP_CATALOG[result.reason]!.related);
      // summary_context is how every step reads its links.
      const stages = new Set(["summary", result.context_task, ...result.related_contexts]);
      for (const name of result.recommended_tools)
        expect(stages.has(toolStage.get(name) ?? ""), `${result.reason} recommends ${name}`).toBe(true);
    }
  });
});
