import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type AuthSession } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { stageOperations } from "../src/stage-contracts.js";

const current = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const attemptRef = "11111111-1111-4111-8111-111111111111";
const nextAttempt = "44444444-4444-4444-8444-444444444444";
const expires = "2099-09-16T22:00:00Z";
const session: AuthSession = { userId: "founder", client: {} };
const workspace = { state: "ready_for_connections" as const, workspace: { workspace_ref: current, name: "Example" }, next_action: null };
const submission = { state: "applied" as const, submission_ref: attemptRef, run_ref: null, import_status: "imported" as const,
  changed_sections: ["workspace" as const], artifact_actions: { workspace: "applied" }, regenerate_icp: false,
  regenerate_prompt: false, workspace_ref: current, created: true };
const base: Partial<AppDependencies> = {
  authenticate: async () => ({ ok: true, session }), getWorkspace: async () => workspace,
 log: () => {},
};
function request(app: ReturnType<typeof createApp>, stage: string, method = "GET", body?: unknown, query = "", client = "v8") {
  return app.request(`/v1/workspace/${stage}${query}`, { method,
    headers: { authorization: "Bearer scoped", "content-type": "application/json", "x-lifty-client-contract": `lifty-cli-context.${client}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("authenticated workspace stage adapters", () => {
  it("authenticates all stage methods including unsupported writes; context remains public", async () => {
    const app = createApp();
    for (const stage of Object.keys(stageOperations)) {
      for (const method of ["GET", "POST", "PATCH"]) expect((await request(app, stage, method, method === "GET" ? undefined : {})).status).toBe(401);
    }
    expect((await app.request("/v1/context/business")).status).toBe(200);
  });

  it.each(["v8"])("applies the existing calibration gate and enqueues one run for %s", async version => {
    const start = vi.fn(async () => ({ state: "queued" as const, run_ref: attemptRef, requested_leads: 5, workspace: workspace.workspace, created: true }));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const app = createApp({ ...base, startRun: start, enqueueFirstRun: enqueue });
    expect((await request(app, "sample-review", "POST", {}, "", version)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(attemptRef, 0);
    expect((await request(app, "sample-review", "POST", {}, "", "v7")).status).toBe(409);
    expect(start).toHaveBeenCalledExactlyOnceWith(session);
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
});

describe("provider authorization stages", () => {
  const flows = [
    { provider: "hubspot", stage: "crm", input: {}, query: "" },
    { provider: "slack", stage: "notifications", input: {}, query: "" },
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
      const app = createApp({ ...base, getConnectionAttempt: getAttempt,
        startHubspotConnect: async () => ({ provider: "hubspot", attempt_ref: attemptRef, expires_at: expires, connect_url: url, expires_in_seconds: 600 }),
        startSlackConnect: async () => ({ provider: "slack", attempt_ref: attemptRef, expires_at: expires, connect_url: url, expires_in_seconds: 600 }) });
      const started = await request(app, flow.stage, "POST", flow.input);
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ status: "authorization_required", attempt_ref: attemptRef, connection_url: url, expires_at: expires });
      const query = `?${flow.query}attempt_ref=${attemptRef}`;
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "pending", attempt_ref: attemptRef, retry_after_seconds: 3 });
      readFails = true;
      expect((await request(app, flow.stage, "GET", undefined, query)).status).toBe(502);
      readFails = false;
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "pending", attempt_ref: attemptRef });
      state = "connected";
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toEqual({ status: "connected", attempt_ref: attemptRef, verified: true });
      state = "expired";
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "expired", attempt_ref: attemptRef });
      state = "denied";
      expect(await (await request(app, flow.stage, "GET", undefined, query)).json()).toMatchObject({ status: "denied", attempt_ref: attemptRef });
    });
  }
});
