import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { WorkspaceCampaignRequest, type WorkspaceCampaignInput, type WorkspaceCampaignOutput } from "../src/workspace-campaign-contracts.js";
import { createWorkspaceCampaignOperations } from "../src/workspace-campaign.js";
import type { OnboardingState } from "../src/onboarding-state.js";
import type { OnboardingStatus, RunStatus, WorkspaceStatus } from "../src/contracts.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { confirmedDraft, localConfiguration } from "./onboarding-fixtures.js";
import { getNextStep } from "../src/next-step.js";
import { getOnboardingState } from "../src/onboarding-state.js";
import { getWorkspaceStatus, getOnboardingStatus, getRunStatus, getCrmSyncStatus } from "../src/workspace-operations.js";
import { createHubspotConnectOperations } from "../src/hubspot-connect.js";

const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" };
const saved = { state: "saved" as const, revision: 1, workspace_ref: workspace.workspace_ref,
  draft: confirmedDraft, draft_ready: false, configuration: null, idempotency_key: null, receipt: null, updated_at: "2026-09-28T00:00:00Z" };
const imported = { state: "imported" as const, submission_ref: "receipt", draft_digest: "sha256:abc",
  submitted_at: "2026-09-28T00:00:00Z", workspace, summary: { icp: null, prompt: null } };
const run = { state: "succeeded" as const, run_ref: "run", requested_leads: 5, leads_discovered: 5,
  leads_researched: 5, error_code: null, started_at: "2026-09-28T00:00:00Z", completed_at: "2026-09-28T00:01:00Z", workspace, leads: [] };
const headers = { authorization: "Bearer founder", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT };
const example = [...readFileSync(new URL("../src/agent-context/campaign.md", import.meta.url), "utf8").matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!))[0];
const configure = WorkspaceCampaignRequest.parse(example.request);
if (configure.operation !== "configure") throw new Error("Expected runnable configure example");
const shared = { ...configure.payload.configuration,
  audience: { policy: "qualified_ab_v1" as const, lead_ids: null, includes_future_leads: true },
  linkedin: { ...configure.payload.configuration.linkedin!, sender: "https://www.linkedin.com/in/founder", timezone: "America/Argentina/Buenos_Aires", invitation_note: null },
  email: null, not_before: null, stop_on_reply: true as const };
const unconfigured: WorkspaceCampaignOutput = { workspace_ref: workspace.workspace_ref, state: "unconfigured", outreach_enabled: false,
  version_ref: null, digest: null, configuration: null, continuing_versions: [], blocked_leads: [], eligible_count: 0,
  progress: { enrolled: 0, blocked: 0, completed: 0 }, previews: [], blockers: [] };
const draftCampaign: WorkspaceCampaignOutput = { ...unconfigured, state: "draft", version_ref: "44444444-4444-4444-8444-444444444444",
  digest: "a".repeat(64), configuration: shared, preparation: { state: "pending", errors: [] }, eligible_count: 3 };

describe("server-observed onboarding guidance", () => {
  it("advances from an empty account through persisted interview, import and sample review using reads only", async () => {
    let current: WorkspaceStatus = { state: "needs_workspace", workspace: null, next_action: "provision_workspace" };
    let draft: OnboardingState = { state: "none", revision: 0 };
    let onboarding: OnboardingStatus = { state: "none" };
    let research: RunStatus = { state: "none" };
    let campaign: WorkspaceCampaignOutput = unconfigured;
    const mutate = vi.fn();
    const readCampaign = vi.fn(async (_session: unknown, _input: WorkspaceCampaignInput) => campaign);
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => current, getOnboardingState: async () => draft,
      getOnboardingStatus: async () => onboarding, getRunStatus: async () => research, workspaceCampaign: readCampaign,
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
    // Each Section 1 step returns its short playbook, never a full stage guide.
    const within = (result: unknown, limit: number) => expect(JSON.stringify(result).length).toBeLessThan(limit);
    const missing = await next();
    expect(missing).toMatchObject({ step: "business", reason: "workspace_missing", section: "leads",
      gates: { next: "company", missing: ["company", "offer", "motion", "market", "exclusions", "boundaries", "persona"], issues: [] },
      guide: { task: "step-interview", schemas: { draft: expect.any(Object) }, references: { interview: expect.any(String) } },
      context_task: "onboarding", recommended_tools: ["business_onboarding_state", "business_onboarding_save", "business_get", "business_post"] });
    expect(missing.actions[0]).toMatch(/^Reply to the founder in one line now/);
    expect(missing.actions.join("\n")).toContain("business_post {name, description, website_url}");
    expect(missing.guide.operations).toBeUndefined();
    within(missing, 25_000);
    current = { state: "ready_for_connections", workspace, next_action: null };
    expect(await next()).toMatchObject({ step: "interview", guide: { task: "step-interview" } });
    draft = { ...saved, draft: { ...confirmedDraft, personas: [], icp: { ...confirmedDraft.icp, hard_disqualifiers: [] } } };
    const resumed = await next();
    expect(resumed).toMatchObject({ step: "interview", saved: { revision: 1, draft_ready: false },
      gates: { next: "exclusions", missing: ["exclusions", "persona"] } });
    expect(resumed.actions.join("\n")).toContain("Ask next: at least one hard exclusion");
    expect(resumed.actions.join("\n")).toContain("Still missing after that: persona.");
    expect(resumed.actions.join("\n")).not.toContain("business_post");
    // A draft from before the offer gate resumes at the offer, not at the start.
    const { value_proposition: _value, pain_points: _pains, offerings: _offerings, ...company } = confirmedDraft.company;
    draft = { ...saved, draft: { ...confirmedDraft, company } };
    const offer = await next();
    expect(offer).toMatchObject({ gates: { next: "offer", missing: ["offer"] } });
    expect(offer.actions.join("\n")).toContain("Ask next: the value proposition, the buyer's top pain points");
    draft = saved;
    expect(await next()).toMatchObject({ step: "interview", gates: { next: null, missing: [] } });
    draft = { ...saved, draft_ready: true };
    const configuration = await next();
    expect(configuration).toMatchObject({ step: "configuration", guide: { task: "step-configuration", references: { configuration: expect.any(String) } },
      recommended_tools: ["targeting_onboarding_context", "business_onboarding_save", "targeting_post", "targeting_onboarding_status"] });
    within(configuration, 40_000);
    draft = { ...saved, revision: 2, draft_ready: true, configuration: localConfiguration };
    const submission = await next();
    expect(submission).toMatchObject({ step: "submission", saved: { revision: 2 }, guide: { task: "step-submission", references: {} } });
    expect(submission.actions[0]).toContain("expected_revision 2");
    within(submission, 12_000);
    onboarding = { ...imported, state: "pending", summary: null };
    expect(await next()).toMatchObject({ step: "import", state: "pending", receipt: { submission_ref: "receipt" } });
    onboarding = imported;
    const notStarted = await next();
    expect(notStarted).toMatchObject({ step: "sample-review", reason: "sample_not_started", guide: { task: "step-sample" } });
    // After import only the confirmed draft is useful for the recap.
    expect(notStarted.saved).toEqual({ state: "saved", revision: 2, workspace_ref: workspace.workspace_ref, draft: confirmedDraft, updated_at: saved.updated_at });
    within(notStarted, 12_000);
    research = { ...run, state: "running", completed_at: null };
    const pending = await next();
    expect(pending).toMatchObject({ step: "sample-review", state: "pending", recommended_tools: ["sample_review_progress"] });
    expect(pending.actions[0]).toContain("run_ref run");
    research = run;
    const review = await next();
    expect(review).toMatchObject({ state: "review", reason: "sample_ready_for_founder_review", guide: { task: "step-review" } });
    // HubSpot readers are not configured in this app: the CRM action says to read it first.
    expect(review.actions[2]).toMatch(/^Read crm_get before offering HubSpot/);
    within(review, 40_000);
    campaign = draftCampaign;
    const preparing = await next();
    expect(preparing).toMatchObject({ state: "pending", step: "campaign", reason: "campaign_preparing",
      guide: { task: "summary" }, receipt: { state: "draft", version_ref: draftCampaign.version_ref, preparation: "pending" } });
    // Chat connectors stall on the ~300 KB campaigns guide; resume stays small.
    expect(JSON.stringify(preparing).length).toBeLessThan(80_000);
    campaign = { ...draftCampaign, preparation: { state: "failed", errors: ["render_failed"] } };
    expect(await next()).toMatchObject({ state: "blocked", reason: "campaign_preparation_failed" });
    campaign = { ...draftCampaign, preparation: { state: "ready", errors: [] }, blockers: ["sender_not_connected"] };
    expect(await next()).toMatchObject({ state: "action_required", reason: "campaign_draft", receipt: { blockers: ["sender_not_connected"] } });
    campaign = { ...draftCampaign, state: "paused", preparation: { state: "ready", errors: [] } };
    expect(await next()).toMatchObject({ state: "action_required", reason: "campaign_paused" });
    campaign = { ...draftCampaign, state: "active", outreach_enabled: true, preparation: { state: "ready", errors: [] } };
    expect(await next()).toMatchObject({ state: "complete", step: "campaign", reason: "campaign_active", recommended_tools: ["campaigns_get", "summary_context"] });
    expect(readCampaign.mock.calls.map(([, input]) => input)).toEqual(
      Array(readCampaign.mock.calls.length).fill({ operation: "status", payload: { workspace: workspace.workspace_ref } }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("uses the production persisted-state readers without provider calls, reconciliation or job enqueue", async () => {
    const data: Record<string, unknown> = {
      get_lifty_workspace_status: { state: "ready_for_connections", workspace, next_action: null },
      get_lifty_onboarding_state: { state: "none", revision: 0 },
      get_lifty_onboarding_status: imported,
      get_lifty_run_status: run,
      lifty_workspace_outreach: unconfigured,
      get_lifty_hubspot_connection: { provider: "hubspot", status: "not_connected" },
      get_lifty_crm_sync_status: { state: "none" },
    };
    const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (!Object.hasOwn(data, name)) throw new Error(`Unexpected non-read RPC: ${name}`);
      return { data: data[name], error: null };
    });
    const hubspot = createHubspotConnectOperations({ publicBaseUrl: "https://api.example.test", clientId: "client", fetchImpl: async () => { throw new Error("Unexpected provider call"); } } as never);
    const result = await getNextStep({ getWorkspace: getWorkspaceStatus, getOnboardingState,
      getOnboardingStatus, getRunStatus, workspaceCampaign: createWorkspaceCampaignOperations("k".repeat(32)),
      getHubspotConnection: hubspot.getConnection, getCrmSyncStatus }, { userId: "founder", client: { rpc } });
    expect(result).toMatchObject({ state: "review", reason: "sample_ready_for_founder_review" });
    expect(result.actions[2]).toMatch(/^Ask once whether they want these leads and their research in HubSpot/);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(Object.keys(data));
    expect(rpc.mock.calls[4]?.[1]).toMatchObject({ p_operation: "status", p_payload: { workspace: workspace.workspace_ref } });
  });

  it("chooses one CRM action from the saved HubSpot connection and latest sync, never blocking on them", async () => {
    const connected = { provider: "hubspot" as const, status: "connected" as const, portal_id: "123", hub_domain: null,
      granted_scopes: [], connected_at: null, reconnect_required: false };
    const syncRun = { run_ref: "sync-1", requested_leads: 5, leads_synced: 5, error_code: null, portal_id: "123",
      started_at: "2026-09-28T00:02:00Z", completed_at: null, workspace };
    const reads = (hubspot: unknown, sync: unknown) => ({ getWorkspace: async () => ({ state: "ready_for_connections" as const, workspace, next_action: null }),
      getOnboardingState: async () => ({ state: "none" as const, revision: 0 as const }), getOnboardingStatus: async () => imported,
      getRunStatus: async () => run, workspaceCampaign: async () => unconfigured,
      getHubspotConnection: async () => { if (hubspot instanceof Error) throw hubspot; return hubspot as never; },
      getCrmSyncStatus: async () => { if (sync instanceof Error) throw sync; return sync as never; } });
    const crm = async (hubspot: unknown, sync: unknown) => (await getNextStep(reads(hubspot, sync), { userId: "founder", client: {} })).actions[2];
    expect(await crm(new Error("offline"), { state: "none" })).toMatch(/^Read crm_get before offering HubSpot/);
    expect(await crm({ ...connected, reconnect_required: true }, { state: "none" })).toMatch(/^HubSpot needs reconnecting/);
    expect(await crm(connected, new Error("offline"))).toMatch(/read crm_sync_status before offering a sync/);
    expect(await crm(connected, { state: "none" })).toMatch(/nothing is synced yet: offer to sync these leads/);
    expect(await crm(connected, { ...syncRun, state: "running", leads_synced: null })).toContain("in progress (run_ref sync-1)");
    expect(await crm(connected, { ...syncRun, state: "succeeded", completed_at: "2026-09-28T00:03:00Z" })).toContain("finished (5 leads)");
    expect(await crm(connected, { ...syncRun, state: "failed", leads_synced: null, error_code: "portal_scope_missing" })).toContain("failed (portal_scope_missing)");
    // A receipt for another workspace is not evidence about this one.
    const foreign = { ...syncRun, state: "succeeded", workspace: { ...workspace, workspace_ref: "33333333-3333-4333-8333-333333333333" } };
    expect(await crm(connected, foreign)).toMatch(/read crm_sync_status before offering a sync/);
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

  it("reports an unreadable or foreign campaign as unavailable instead of an unreviewed sample", async () => {
    const base: Partial<AppDependencies> = { authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }), log: () => {},
      getOnboardingState: async () => ({ state: "none", revision: 0 }), getOnboardingStatus: async () => imported, getRunStatus: async () => run };
    const failing = createApp({ ...base, workspaceCampaign: async () => {
      throw new PublicError({ status: 502, code: "WORKSPACE_CAMPAIGN_UNAVAILABLE", message: "The workspace sequence could not be verified." }); } });
    const failed = await failing.request("/v1/workspace/next-step", { headers });
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain("sample_ready_for_founder_review");
    const foreign = createApp({ ...base, workspaceCampaign: async () => ({ ...unconfigured, workspace_ref: "33333333-3333-4333-8333-333333333333" }) });
    const mismatch = await foreign.request("/v1/workspace/next-step", { headers });
    expect(mismatch.status).toBe(502); expect(await mismatch.text()).not.toContain("33333333");
  });
});
