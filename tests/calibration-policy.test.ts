import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { StartRunResultSchema } from "../src/contracts.js";

const authenticate = async () => ({ ok: true as const, session: { userId: "founder", client: {} } });
const headers = { "x-lifty-client-contract": "lifty-cli-context.v4" };
const checkpoint = {
  state: "failed", run_ref: "22222222-2222-4222-8222-222222222222",
  requested_leads: 5, workspace: { workspace_ref: "ws_opaque", name: "Example" },
  created: false, attempt: 0, calibration_policy: "qualified_ab_v1", error_code: "calibration_review_required",
} as const;

describe("calibration policy rollout", () => {
  it.each([undefined, "lifty-cli-context.v3", "unknown"])("rejects an incompatible client before starting or enqueueing (%s)", async version => {
    const startRun = vi.fn(); const enqueueFirstRun = vi.fn();
    const app = createApp({ authenticate, startRun, enqueueFirstRun });
    const response = await app.request("/v1/workspace/runs", { method: "POST", headers: version ? { "x-lifty-client-contract": version } : {} });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CONTEXT_CLIENT_UNSUPPORTED");
    expect(startRun).not.toHaveBeenCalled(); expect(enqueueFirstRun).not.toHaveBeenCalled();
  });

  it("reattaches a saved quality checkpoint without enqueueing any work", async () => {
    const startRun = vi.fn(async () => checkpoint); const enqueueFirstRun = vi.fn();
    const app = createApp({ authenticate, startRun, enqueueFirstRun });
    const response = await app.request("/v1/workspace/runs", { method: "POST", headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(checkpoint);
    expect(startRun).toHaveBeenCalledOnce(); expect(enqueueFirstRun).not.toHaveBeenCalled();
  });

  it("does not accept a terminal start response for arbitrary failures", () => {
    expect(StartRunResultSchema.safeParse(checkpoint).success).toBe(true);
    for (const invalid of [{ error_code: "research_failed" }, { created: true }, { calibration_policy: "tier_a_v1" }]) {
      expect(StartRunResultSchema.safeParse({ ...checkpoint, ...invalid }).success).toBe(false);
    }
  });

  it("keeps status read-only for old clients and preserves the policy and actual grades", async () => {
    const status = {
      state: "succeeded" as const, run_ref: checkpoint.run_ref, requested_leads: 5,
      calibration_policy: "qualified_ab_v1" as const, leads_discovered: 5, leads_researched: 5,
      error_code: null, started_at: "2026-09-16T00:00:00Z", completed_at: "2026-09-16T00:01:00Z",
      workspace: checkpoint.workspace, leads: [{ name: "Founder", title: "CEO", company: "Example",
        linkedin_url: "https://linkedin.com/in/founder", tier: "B", fit_rationale: "Relevant product, weaker buying evidence.", stage: "qualified" }],
    };
    const response = await createApp({ authenticate, getRunStatus: async () => status }).request("/v1/workspace/runs");
    expect(response.status).toBe(200); expect(await response.json()).toEqual(status);
  });
});
