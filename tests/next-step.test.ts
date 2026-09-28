import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import type { OnboardingState } from "../src/onboarding-state.js";
import type { OnboardingStatus, RunStatus, WorkspaceStatus } from "../src/contracts.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { confirmedDraft, localConfiguration } from "./onboarding-fixtures.js";
import { getNextStep } from "../src/next-step.js";
import { getOnboardingState } from "../src/onboarding-state.js";
import { getWorkspaceStatus, getOnboardingStatus, getRunStatus } from "../src/workspace-operations.js";

const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" };
const saved = { state: "saved" as const, revision: 1, workspace_ref: workspace.workspace_ref,
  draft: confirmedDraft, draft_ready: false, configuration: null, idempotency_key: null, receipt: null, updated_at: "2026-09-28T00:00:00Z" };
const imported = { state: "imported" as const, submission_ref: "receipt", draft_digest: "sha256:abc",
  submitted_at: "2026-09-28T00:00:00Z", workspace, summary: { icp: null, prompt: null } };
const run = { state: "succeeded" as const, run_ref: "run", requested_leads: 5, leads_discovered: 5,
  leads_researched: 5, error_code: null, started_at: "2026-09-28T00:00:00Z", completed_at: "2026-09-28T00:01:00Z", workspace, leads: [] };
const headers = { authorization: "Bearer founder", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT };

describe("server-observed onboarding guidance", () => {
  it("advances from an empty account through persisted interview, import and sample review using reads only", async () => {
    let current: WorkspaceStatus = { state: "needs_workspace", workspace: null, next_action: "provision_workspace" };
    let draft: OnboardingState = { state: "none", revision: 0 };
    let onboarding: OnboardingStatus = { state: "none" };
    let research: RunStatus = { state: "none" };
    const mutate = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => current, getOnboardingState: async () => draft,
      getOnboardingStatus: async () => onboarding, getRunStatus: async () => research,
      createWorkspace: mutate, submitOnboarding: mutate, startRun: mutate, saveOnboardingState: mutate,
      emailAvailable: true, getEmailConnection: mutate, getLinkedinConnection: mutate,
      getEmailAccountAttempt: mutate });
    const next = async () => {
      const response = await app.request("/v1/workspace/next-step", { headers });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json();
      expect(result.guide.instructions.length).toBeGreaterThan(100);
      return result;
    };
    expect(await next()).toMatchObject({ step: "business", reason: "workspace_missing" });
    current = { state: "ready_for_connections", workspace, next_action: null };
    expect(await next()).toMatchObject({ step: "interview", guide: { task: "onboarding" } });
    draft = saved;
    expect(await next()).toMatchObject({ step: "interview", saved: { revision: 1, draft_ready: false } });
    draft = { ...saved, draft_ready: true };
    expect(await next()).toMatchObject({ step: "configuration", recommended_tools: ["targeting_onboarding_context", "targeting_onboarding_save"] });
    draft = { ...saved, revision: 2, draft_ready: true, configuration: localConfiguration };
    expect(await next()).toMatchObject({ step: "submission", saved: { revision: 2 } });
    onboarding = { ...imported, state: "pending", summary: null };
    expect(await next()).toMatchObject({ step: "import", state: "pending", receipt: { submission_ref: "receipt" } });
    onboarding = imported;
    expect(await next()).toMatchObject({ step: "sample-review", reason: "sample_not_started" });
    research = { ...run, state: "running", completed_at: null };
    expect(await next()).toMatchObject({ step: "sample-review", state: "pending", recommended_tools: ["sample_review_progress"] });
    research = run;
    expect(await next()).toMatchObject({ state: "review", reason: "sample_ready_for_founder_review" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("uses the production persisted-state readers without provider calls, reconciliation or job enqueue", async () => {
    const data: Record<string, unknown> = {
      get_lifty_workspace_status: { state: "ready_for_connections", workspace, next_action: null },
      get_lifty_onboarding_state: { state: "none", revision: 0 },
      get_lifty_onboarding_status: imported,
      get_lifty_run_status: run,
    };
    const rpc = vi.fn(async (name: string) => {
      if (!Object.hasOwn(data, name)) throw new Error(`Unexpected non-read RPC: ${name}`);
      return { data: data[name], error: null };
    });
    const result = await getNextStep({ getWorkspace: getWorkspaceStatus, getOnboardingState,
      getOnboardingStatus, getRunStatus }, { userId: "founder", client: { rpc } });
    expect(result).toMatchObject({ state: "review", reason: "sample_ready_for_founder_review" });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(Object.keys(data));
  });

  it("preserves legacy imported state with no cache and treats import/run failures as blockers", async () => {
    let onboarding: OnboardingStatus = imported;
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      getOnboardingState: async () => ({ state: "none", revision: 0 }), getOnboardingStatus: async () => onboarding,
      getRunStatus: async () => ({ ...run, state: "failed", error_code: "research_unavailable" }) });
    expect(await (await app.request("/v1/workspace/next-step", { headers })).json()).toMatchObject({ state: "blocked", reason: "sample_failed" });
    onboarding = { ...imported, state: "failed", summary: null, error_code: "prompt_hand_tuned" };
    expect(await (await app.request("/v1/workspace/next-step", { headers })).json()).toMatchObject({ state: "blocked", reason: "import_failed" });
  });

  it("fails closed for missing authentication, unavailable state and inconsistent workspace evidence", async () => {
    expect((await createApp().request("/v1/workspace/next-step")).status).toBe(401);
    const base: Partial<AppDependencies> = { authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }), log: () => {} };
    const unavailable = createApp({ ...base, getOnboardingState: async () => { throw new Error("offline"); } });
    expect((await unavailable.request("/v1/workspace/next-step", { headers })).status).toBe(500);
    const wrong = createApp({ ...base, getOnboardingState: async () => ({ ...saved, workspace_ref: "33333333-3333-4333-8333-333333333333" }) });
    const response = await wrong.request("/v1/workspace/next-step", { headers });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("33333333");
  });
});
