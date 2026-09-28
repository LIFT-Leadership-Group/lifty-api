import { describe, expect, it } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { confirmedDraft, localConfiguration, onboardingContext } from "./onboarding-fixtures.js";
import { getOnboardingState } from "../src/onboarding-state.js";
import { stageOperations } from "../src/stage-contracts.js";
const saved = { state: "saved", revision: 1, workspace_ref: null, draft: { company: { name: "Partial" } }, configuration: null, receipt: null, idempotency_key: null, updated_at: "2026-09-28T00:00:00Z" };
const auth = { ok: true as const, session: { userId: "founder", client: {} } };
const request = (body: unknown) => ({ method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
describe("portable onboarding state", () => {
  it("reads partial state through authenticated RPC and computes readiness independently of claimed status", async () => {
    for (const draft of [saved.draft, { status: "ready_for_auth" }, confirmedDraft]) {
      const state = await getOnboardingState({ userId: "founder", client: { rpc: async (name: string) => { expect(name).toBe("get_lifty_onboarding_state"); return { data: { ...saved, draft }, error: null }; } } });
      expect(state.state === "saved" && state.draft_ready).toBe(draft === confirmedDraft);
    }
  });
  it("preserves the accepted MCP key with its receipt when another client reads server state", async () => {
    const workspace_ref = "63900000-0000-4000-a000-00000000000a";
    const accepted = { ...saved, draft: confirmedDraft, configuration: localConfiguration, workspace_ref,
      idempotency_key: "mcp:accepted-key", receipt: { state: "submitted", submission_ref: "accepted-receipt",
        draft_digest: "sha256:accepted", import_status: "pending", created: false,
        workspace: { workspace_ref, name: "Example" } } };
    const app = createApp({ authenticate: async () => auth,
      getOnboardingState: session => getOnboardingState({ ...session, client: { rpc: async () => ({ data: accepted, error: null }) } }) });
    const response = await app.request("/v1/onboarding/state", { headers: { authorization: "Bearer second-client" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotency_key: "mcp:accepted-key", receipt: accepted.receipt,
      draft: confirmedDraft, configuration: localConfiguration, draft_ready: true });
  });
  it("requires authentication and saves partial interview without requiring a workspace", async () => {
    let writes = 0;
    const app = createApp({ authenticate: async request => request.headers.has("authorization") ? auth : { ok: false, reason: "invalid_session" },
      saveOnboardingState: async (_session, input) => { writes++; expect(input.expected_revision).toBe(0); return { ...saved, state: "saved", draft_ready: false }; } });
    expect((await app.request("/v1/onboarding/state")).status).toBe(401);
    const response = await app.request("/v1/onboarding/state", request({ expected_revision: 0, draft: saved.draft, configuration: null }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(writes).toBe(1);
    expect((await app.request("/v1/onboarding/state", request({ expected_revision: 1, draft: saved.draft, configuration: null, workspace_ref: "foreign" }))).status).toBe(400);
    expect(writes).toBe(1);
  });
  it("rejects unbound configurations and oversized drafts before persistence", async () => {
    const app = createApp({ authenticate: async () => auth, saveOnboardingState: async () => { throw Error("must not persist"); } });
    expect((await app.request("/v1/onboarding/state", request({ expected_revision: 0, draft: saved.draft, configuration: localConfiguration }))).status).toBe(422);
    expect((await app.request("/v1/onboarding/state", request({ expected_revision: 0, draft: { text: "x".repeat(140000) }, configuration: null }))).status).toBe(413);
  });
  it("propagates idempotency and revision to the RPC, recovering a lost enqueue on exact retry", async () => {
    let enqueues = 0;
    const app = createApp({ authenticate: async () => auth, getOnboardingContext: async () => onboardingContext,
      submitOnboarding: async (_s, _d, _c, options) => { expect(options).toEqual({ idempotency_key: "same-key", expected_revision: 3 }); return { state: "submitted", submission_ref: "receipt", draft_digest: "sha256:abc", workspace: { workspace_ref: "workspace", name: "Example" }, created: false, import_status: "pending" }; },
      enqueueOnboardingImport: async ref => { expect(ref).toBe("receipt"); enqueues++; if(enqueues === 1) throw Error("lost enqueue"); return { id: "job" }; } });
    const input = { ...request({ draft: confirmedDraft, configuration: localConfiguration, idempotency_key: "same-key", expected_revision: 3 }), method: "POST" };
    expect((await app.request("/v1/onboarding", input)).status).toBe(500);
    expect((await app.request("/v1/onboarding", input)).status).toBe(200); expect(enqueues).toBe(2);
  });
  it("publishes the same state contracts through business and configuration operation catalogs", () => {
    for (const stage of ["business", "targeting", "research-criteria", "commercial-voice"]) {
      expect(stageOperations[stage]?.onboarding_state?.route).toBe("/v1/onboarding/state");
      expect(stageOperations[stage]?.onboarding_save?.method).toBe("PATCH");
    }
  });
});
