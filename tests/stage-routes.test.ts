import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type AuthSession } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { stageOperations } from "../src/stage-contracts.js";
import { EmailConnectionStatus } from "../src/email-contracts.js";
import { LinkedinConnectionStatus, LINKEDIN_POLICY } from "../src/linkedin-contracts.js";
import { confirmedDraft, localConfiguration, onboardingContext } from "./onboarding-fixtures.js";

const current = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const attemptRef = "11111111-1111-4111-8111-111111111111";
const nextAttempt = "44444444-4444-4444-8444-444444444444";
const expires = "2099-09-16T22:00:00Z";
const session: AuthSession = { userId: "founder", client: {} };
const workspace = { state: "ready_for_connections" as const, workspace: { workspace_ref: current, name: "Example" }, next_action: null };
const config = { workspace_ref: current, config: { workspace: { version: `sha256:${"a".repeat(64)}`, name: "Example", description: "Keep this description", daily_discovery_target: 10 } } };
const submission = { state: "applied" as const, submission_ref: attemptRef, run_ref: null, import_status: "imported" as const,
  changed_sections: ["workspace" as const], artifact_actions: { workspace: "applied" }, regenerate_icp: false,
  regenerate_prompt: false, workspace_ref: current, created: true };
const base: Partial<AppDependencies> = {
  authenticate: async () => ({ ok: true, session }), getWorkspace: async () => workspace,
  getConfig: async () => structuredClone(config), log: () => {},
};
function request(app: ReturnType<typeof createApp>, stage: string, method = "GET", body?: unknown, query = "", client = "v5") {
  return app.request(`/v1/workspace/${stage}${query}`, { method,
    headers: { authorization: "Bearer scoped", "content-type": "application/json", "x-lifty-client-contract": `lifty-cli-context.${client}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const emailStatus = (() => { const result = EmailConnectionStatus.parse({ provider: "unipile", channel: "email", workspace_ref: current,
  status: "connected", email: "founder@example.test", mailbox_use: "personal", daily_limit: 10,
  warmup_required: false, sending_enabled: false, connection_ref: foreign, intent_ref: null, failure_code: null }); if (result.status !== "connected") throw new Error("fixture"); return result; })();
const linkedinStatus = (() => { const result = LinkedinConnectionStatus.parse({ provider: "unipile", channel: "linkedin", workspace_ref: current,
  status: "connected", profile_id: "Founder", profile_url: "https://www.linkedin.com/in/founder/", display_name: "Founder",
  timezone: "America/Argentina/Buenos_Aires", account_use: "personal", other_automation: false, policy: LINKEDIN_POLICY,
  health_status: "running", sending_enabled: false, connection_ref: foreign, intent_ref: null, failure_code: null }); if (result.status !== "connected") throw new Error("fixture"); return result; })();

describe("authenticated workspace stage adapters", () => {
  it("authenticates all stage methods including unsupported writes; context remains public", async () => {
    const app = createApp();
    for (const stage of Object.keys(stageOperations)) {
      for (const method of ["GET", "POST", "PATCH"]) expect((await request(app, stage, method, method === "GET" ? undefined : {})).status).toBe(401);
    }
    expect((await app.request("/v1/context/business")).status).toBe(200);
  });

  it("creates, partially updates and reads business through existing handlers without losing unrelated values", async () => {
    let provisioned = false;
    const saved = structuredClone(config);
    const submit = vi.fn(async (_session, payload) => {
      Object.assign(saved.config.workspace, payload.values);
      return submission;
    });
    const app = createApp({ ...base, getWorkspace: async () => provisioned ? workspace : { state: "needs_workspace", workspace: null, next_action: "provision_workspace" },
      createWorkspace: async (_session, input) => { provisioned = true; saved.config.workspace.name = input.name; return { state: workspace.state, workspace: workspace.workspace, created: true }; },
      getConfig: async () => saved, submitConfigUpdate: submit });
    expect(await (await request(app, "business")).json()).toMatchObject({ workspace: { state: "needs_workspace" }, configuration: null });
    expect((await request(app, "business", "POST", { name: "First name" })).status).toBe(200);
    const response = await request(app, "business", "PATCH", { section: "workspace", values: { name: "New name" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "applied", submission_ref: attemptRef });
    expect(submit).toHaveBeenCalledWith(session, { section: "workspace", values: { name: "New name" } });
    const readback = await (await request(app, "business")).json();
    expect(readback.configuration.config.workspace).toMatchObject({ name: "New name", description: "Keep this description", daily_discovery_target: 10 });
    expect((await request(app, "business", "PATCH", { section: "workspace", values: { daily_discovery_target: 99 } })).status).toBe(400);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([["targeting", "icp", { person_locations: ["Argentina"] }], ["commercial-voice", "tone", { cta: "Talk" }],
    ["research-criteria", "prompt", null]] as const)("keeps %s writes scoped and preserves queued receipt semantics", async (stage, section, values) => {
    const submit = vi.fn(async () => ({ ...submission, state: "queued" as const, import_status: "pending" as const,
      changed_sections: [section], artifact_actions: { prompt: "queued" }, regenerate_prompt: true }));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const app = createApp({ ...base, submitConfigUpdate: submit, enqueueConfigUpdate: enqueue });
    const input = values ? { section, values } : { section, instruction: "Require evidence of recurring revenue" };
    const response = await request(app, stage, "PATCH", input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "queued", submission_ref: attemptRef, run_ref: attemptRef });
    expect(submit).toHaveBeenCalledWith(session, input);
    expect(enqueue).toHaveBeenCalledOnce();
    expect((await request(app, stage, "PATCH", { section: "workspace", values: { name: "Wrong stage" } })).status).toBe(400);
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each(["targeting", "research-criteria", "commercial-voice"])("submits %s initial setup through the same validated onboarding/import transaction", async stage => {
    const submit = vi.fn(async () => ({ state: "submitted" as const, submission_ref: attemptRef,
      draft_digest: `sha256:${"a".repeat(64)}`, import_status: "pending" as const, workspace: workspace.workspace, created: true }));
    const enqueue = vi.fn(async () => ({ id: "import-job" }));
    const app = createApp({ ...base, getOnboardingContext: async () => ({ ...onboardingContext, workspace: { ...workspace.workspace, description: null } }),
      submitOnboarding: submit, enqueueOnboardingImport: enqueue });
    const response = await request(app, stage, "POST", { draft: confirmedDraft, configuration: localConfiguration });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "queued", run_id: "import-job", submission_ref: attemptRef });
    expect(submit).toHaveBeenCalledWith(session, confirmedDraft, localConfiguration);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("charges the existing shared mutation budget once per aliased provisioning request", async () => {
    const create = vi.fn(async () => ({ state: workspace.state, workspace: workspace.workspace, created: true }));
    const app = createApp({ ...base, createWorkspace: create });
    for (let i = 0; i < 10; i++) expect((await request(app, "business", "POST", { name: "Example" })).status).toBe(200);
    const blocked = await request(app, "business", "POST", { name: "Example" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
    expect(create).toHaveBeenCalledTimes(10);
  });

  it.each(["v5"])("applies the existing calibration gate and enqueues one run for %s", async version => {
    const start = vi.fn(async () => ({ state: "queued" as const, run_ref: attemptRef, requested_leads: 5, workspace: workspace.workspace, created: true }));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const app = createApp({ ...base, startRun: start, enqueueFirstRun: enqueue });
    expect((await request(app, "sample-review", "POST", {}, "", version)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(attemptRef, 0);
    expect((await request(app, "sample-review", "POST", {}, "", "v3")).status).toBe(409);
    expect(start).toHaveBeenCalledOnce();
  });

  it("rejects foreign current-workspace selectors before any CRM or campaign operation", async () => {
    const mapping = vi.fn(); const campaign = vi.fn();
    const app = createApp({ ...base, companyMapping: mapping, emailCampaign: campaign });
    const plan = { version: 1, workspace_ref: foreign, portal_id: "123", mapping_version: "a".repeat(64), schema_version: "b".repeat(64),
      type_values: { top_target: "Top", prospect: "Prospect" }, tier_values: { A: "A", B: "B", C: "C", "Non-ICP": "Non-ICP" }, allow_schema_changes: false };
    expect((await request(app, "crm", "PATCH", plan)).status).toBe(403);
    expect((await request(app, "crm/mapping-context", "GET", undefined, `?workspace_ref=${foreign}`)).status).toBe(400);
    expect((await request(app, "campaigns", "GET", undefined, `?channel=email&workspace=${foreign}&campaign_ref=${attemptRef}`)).status).toBe(403);
    expect((await request(app, "campaigns", "POST", { channel: "email", request: { operation: "target", payload: { workspace: foreign, email: "lead@example.test" } } })).status).toBe(403);
    expect((await request(app, "campaigns", "PATCH", { channel: "email", request: { operation: "activate", payload: { workspace: current, campaign_ref: attemptRef, digest: "a".repeat(64) } } })).status).toBe(400);
    expect(mapping).not.toHaveBeenCalled(); expect(campaign).not.toHaveBeenCalled();
  });

  it("preserves real business rejection and body bounds across stage dispatch", async () => {
    const submit = vi.fn(async () => { throw new PublicError({ status: 409, code: "MULTI_LANE_CONFIG_UNSUPPORTED", message: "Managed externally." }); });
    const app = createApp({ ...base, submitConfigUpdate: submit });
    const response = await request(app, "targeting", "PATCH", { section: "icp", values: { q_keywords: "software" } });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("MULTI_LANE_CONFIG_UNSUPPORTED");
    expect((await request(app, "business", "POST", { name: "x".repeat(133 * 1024) })).status).toBe(413);
  });

  it("returns explicit unsupported writes without mutating configuration", async () => {
    const submit = vi.fn(); const app = createApp({ ...base, submitConfigUpdate: submit });
    for (const [stage, method] of [["capacity", "POST"], ["capacity", "PATCH"], ["sample-review", "PATCH"], ["sending-accounts", "PATCH"]]) {
      const response = await request(app, stage!, method!, {});
      expect(response.status).toBe(405); expect((await response.json()).error.code).toBe("STAGE_OPERATION_UNSUPPORTED");
    }
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("provider authorization stages", () => {
  const flows = [
    { provider: "hubspot", stage: "crm", input: {}, query: "" },
    { provider: "slack", stage: "notifications", input: {}, query: "" },
    { provider: "email", stage: "sending-accounts", input: { channel: "email" }, query: "channel=email&" },
    { provider: "linkedin", stage: "sending-accounts", input: { channel: "linkedin", timezone: "America/Argentina/Buenos_Aires", account_use: "personal", other_automation: false }, query: "channel=linkedin&" },
  ] as const;
  for (const flow of flows) {
    it(`${flow.provider}: hands off real link, verifies the exact pending/reconnected attempt, preserves read failures and expiry`, async () => {
      let state: "pending" | "connected" | "expired" | "denied" = "pending";
      let readFails = false;
      const getAttempt = vi.fn(async (_session, provider, ref, ws) => {
        expect(provider).toBe(flow.provider); expect(ref).toBe(attemptRef); expect(ws).toBe(current);
        if (readFails) throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "Could not verify." });
        if (state === "pending") return { status: "pending" as const, attempt_ref: ref, expires_at: expires, retry_after_seconds: 3 };
        if (state === "connected") return { status: "connected" as const, attempt_ref: ref, verified: true as const };
        return { status: state, attempt_ref: ref };
      });
      const url = `https://api.lifty.test/${flow.provider}/real-authorization`;
      const startEmail = vi.fn(async () => ({ ...emailStatus, status: "pending" as const, intent_ref: attemptRef,
        connect_url: url, expires_in_seconds: 600, expires_at: expires }));
      const startLinkedin = vi.fn(async () => ({ ...linkedinStatus, status: "pending" as const, sending_enabled: false as const,
        intent_ref: attemptRef, connect_url: url, expires_in_seconds: 600, expires_at: expires }));
      const ordinaryEmail = vi.fn(async () => emailStatus); const ordinaryLinkedin = vi.fn(async () => linkedinStatus);
      const app = createApp({ ...base, getConnectionAttempt: getAttempt, getEmailConnection: ordinaryEmail, getLinkedinConnection: ordinaryLinkedin,
        startHubspotConnect: async () => ({ provider: "hubspot", attempt_ref: attemptRef, expires_at: expires, connect_url: url, expires_in_seconds: 600 }),
        startSlackConnect: async () => ({ provider: "slack", attempt_ref: attemptRef, expires_at: expires, connect_url: url, expires_in_seconds: 600 }),
        startEmailConnect: startEmail, startLinkedinConnect: startLinkedin });
      const started = await request(app, flow.stage, "POST", flow.input);
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ status: "authorization_required", attempt_ref: attemptRef, connection_url: url, expires_at: expires });
      if (flow.provider === "email") expect(startEmail).toHaveBeenCalledWith(session, { workspace: current, reconnect: true });
      if (flow.provider === "linkedin") expect(startLinkedin).toHaveBeenCalledWith(session, { workspace: current, timezone: flow.input.timezone, account_use: "personal", other_automation: false, reconnect: true });
      const query = `?${flow.query}attempt_ref=${attemptRef}`;
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "pending", attempt_ref: attemptRef, retry_after_seconds: 3 });
      readFails = true;
      expect((await request(app, flow.stage, "GET", undefined, query)).status).toBe(502);
      readFails = false;
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "pending", attempt_ref: attemptRef });
      state = "connected";
      const reads = ordinaryEmail.mock.calls.length + ordinaryLinkedin.mock.calls.length;
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toEqual({ status: "connected", attempt_ref: attemptRef, verified: true });
      expect(ordinaryEmail.mock.calls.length + ordinaryLinkedin.mock.calls.length).toBe(reads);
      state = "expired";
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "expired", attempt_ref: attemptRef });
      state = "denied";
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "denied", attempt_ref: attemptRef });
    });
  }
  it("passes explicit email reselection to the current workspace and returns its new attempt", async () => {
    const startEmail = vi.fn(async () => ({ ...emailStatus, status: "pending" as const, email: null, mailbox_use: null,
      intent_ref: nextAttempt, connect_url: "https://api.lifty.test/unipile/start?intent=new-selection", expires_in_seconds: 600, expires_at: expires }));
    const app = createApp({ ...base, startEmailConnect: startEmail });
    const response = await request(app, "sending-accounts", "POST", { channel: "email", select_account: true });
    expect(response.status).toBe(200);
    expect(startEmail).toHaveBeenCalledWith(session, { workspace: current, reconnect: true, select_account: true });
    expect(await response.json()).toEqual({ status: "authorization_required", attempt_ref: nextAttempt,
      connection_url: "https://api.lifty.test/unipile/start?intent=new-selection", expires_at: expires });
  });
  it.each([
    { channel: "email", select_account: "true" },
    { channel: "email", select_account: true, email: "injected@example.test" },
    { channel: "email", select_account: true, email_provider: "outlook" },
    { channel: "email", select_account: true, account_id: "foreign" },
    { channel: "email", select_account: true, workspace: foreign },
    { channel: "email", select_account: true, transport: { api_version: "v1" } },
    { channel: "linkedin", timezone: "America/Argentina/Buenos_Aires", account_use: "personal", other_automation: false, select_account: true },
  ])("rejects unsafe reselection input before starting authorization: %j", async input => {
    const startEmail = vi.fn(), startLinkedin = vi.fn();
    const app = createApp({ ...base, startEmailConnect: startEmail, startLinkedinConnect: startLinkedin });
    expect((await request(app, "sending-accounts", "POST", input)).status).toBe(400);
    expect(startEmail).not.toHaveBeenCalled(); expect(startLinkedin).not.toHaveBeenCalled();
  });
  it("keeps a completed attempt authoritative while a newer reconnect is pending", async () => {
    const currentRead = vi.fn(async () => ({ ...emailStatus, status: "pending" as const, intent_ref: nextAttempt }));
    const app = createApp({ ...base, getEmailConnection: currentRead,
      getConnectionAttempt: async (_session, _provider, ref) => ref === attemptRef
        ? { status: "connected", attempt_ref: ref, verified: true }
        : { status: "pending", attempt_ref: ref, expires_at: expires, retry_after_seconds: 3 } });
    expect(await (await request(app, "sending-accounts", "GET", undefined, `?channel=email&attempt_ref=${attemptRef}`)).json()).toEqual({ status: "connected", attempt_ref: attemptRef, verified: true });
    expect(currentRead).not.toHaveBeenCalled();
    expect(await (await request(app, "sending-accounts", "GET", undefined, `?channel=email&attempt_ref=${nextAttempt}`)).json()).toMatchObject({ status: "pending", attempt_ref: nextAttempt });
    expect(currentRead).toHaveBeenCalledWith(session, current, nextAttempt);
  });
});
