import { describe, expect, it, vi } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { EmailConnectResult } from "../src/email-contracts.js";
import { LinkedinConnectResult, LINKEDIN_POLICY } from "../src/linkedin-contracts.js";
import { createHubspotConnectOperations } from "../src/hubspot-connect.js";
import { createSlackConnectOperations } from "../src/slack-connect.js";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createLinkedinConnectOperations } from "../src/linkedin-connect.js";

const workspace = "22222222-2222-4222-8222-222222222222", attempt = "11111111-1111-4111-8111-111111111111";
const expires = "2099-09-16T20:00:00Z";
const flows = [
  { provider: "hubspot", legacy: "/v1/integrations/hubspot/connect", legacyBody: {}, stage: "crm", stageBody: {} },
  { provider: "slack", legacy: "/v1/integrations/slack/connect", legacyBody: {}, stage: "notifications", stageBody: {} },
  { provider: "email", legacy: "/v1/email/connect", legacyBody: { workspace }, stage: "sending-accounts", stageBody: { channel: "email" } },
  { provider: "linkedin", legacy: "/v1/linkedin/connect", legacyBody: { workspace, timezone: "UTC", account_use: "personal", other_automation: false }, stage: "sending-accounts", stageBody: { channel: "linkedin", timezone: "UTC", account_use: "personal", other_automation: false } },
] as const;
function setup() {
  const fetchImpl = vi.fn(async () => { throw new Error("Provider authorization must not contact the network before the browser handoff"); });
  const settings = { dsn: "https://api1.unipile.com:13111", accessToken: "synthetic-provider-key", serverKey: "x".repeat(40),
    clientId: "synthetic-client", clientSecret: "x".repeat(40), publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://auth.lifty.test", publishableKey: "synthetic-public-key", fetchImpl };
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "get_lifty_connection_attempt") return { error: null, data: { status: "connected", attempt_ref: attempt, verified: true } };
    if (name === "create_lifty_hubspot_connect_intent" || name === "create_lifty_slack_connect_intent") {
      return { error: null, data: { intent_token: "a".repeat(64), attempt_ref: attempt, expires_at: expires, expires_in_seconds: 600 } };
    }
    expect(args?.p_operation).toBe("start");
    return { error: null, data: { state: "pending", workspace_ref: workspace, intent_ref: attempt, expires_at: expires,
      email: null, mailbox_use: null, daily_limit: 10, timezone: "UTC" } };
  });
  const session = { userId: "founder", client: { rpc } };
  const hubspot = createHubspotConnectOperations(settings), slack = createSlackConnectOperations(settings);
  const email = createEmailConnectOperations(settings), linkedin = createLinkedinConnectOperations(settings);
  const app = createApp({ authenticate: async () => ({ ok: true, session }), log: () => {},
    getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: workspace, name: "Example" }, next_action: null }),
    startHubspotConnect: hubspot.startConnect, startSlackConnect: slack.startConnect, startEmailConnect: email.start, startLinkedinConnect: linkedin.start });
  return { app, rpc, fetchImpl };
}
function post(app: ReturnType<typeof createApp>, route: string, body: unknown) {
  return app.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("legacy connection response compatibility", () => {
  it.each(flows)("$provider preserves the old public handoff while stages retain exact-attempt metadata", async flow => {
    const { app, rpc, fetchImpl } = setup();
    const legacy = await post(app, flow.legacy, flow.legacyBody);
    expect(legacy.status).toBe(200);
    const payload = await legacy.json();
    expect(payload.connect_url).toMatch(/^https:\/\/api\.lifty\.test\//);
    expect(payload.expires_in_seconds).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty("attempt_ref"); expect(payload).not.toHaveProperty("expires_at");
    if (flow.provider === "hubspot" || flow.provider === "slack") expect(Object.keys(payload).sort()).toEqual(["connect_url", "expires_in_seconds", "provider"]);
    else expect(payload.intent_ref).toBe(attempt);
    const started = await post(app, `/v1/workspace/${flow.stage}`, flow.stageBody);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ status: "authorization_required", attempt_ref: attempt, expires_at: expires, connection_url: expect.stringMatching(/^https:\/\/api\.lifty\.test\//) });
    const query = new URLSearchParams({ attempt_ref: attempt, ...(flow.stage === "sending-accounts" ? { channel: flow.provider } : {}) });
    const verified = await app.request(`/v1/workspace/${flow.stage}?${query}`);
    expect(await verified.json()).toEqual({ status: "connected", attempt_ref: attempt, verified: true });
    expect(rpc).toHaveBeenLastCalledWith("get_lifty_connection_attempt", { p_provider: flow.provider, p_attempt_ref: attempt, p_workspace: workspace });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["email", "linkedin"] as const)("preserves the %s connected variant and subsequent status unchanged", async provider => {
    const email = EmailConnectResult.parse({ provider: "unipile", channel: "email", workspace_ref: workspace, status: "connected", email: "founder@example.test",
      mailbox_use: "personal", daily_limit: 10, warmup_required: false, sending_enabled: false, connection_ref: attempt });
    const linkedin = LinkedinConnectResult.parse({ provider: "unipile", channel: "linkedin", workspace_ref: workspace, status: "connected", profile_id: "Founder",
      profile_url: null, display_name: "Founder", timezone: "UTC", account_use: "personal", other_automation: false, policy: LINKEDIN_POLICY,
      health_status: "running", sending_enabled: false, connection_ref: attempt });
    const result = provider === "email" ? email : linkedin;
    const status = { ...result, intent_ref: null, failure_code: null };
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }), log: () => {},
      startEmailConnect: async () => email, startLinkedinConnect: async () => linkedin,
      getEmailConnection: async () => status as never, getLinkedinConnection: async () => status as never });
    const flow = flows.find(flow => flow.provider === provider)!;
    const response = await post(app, flow.legacy, flow.legacyBody);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    const current = await app.request(`/v1/${provider}?workspace=${workspace}`);
    expect(current.status).toBe(200); expect(await current.json()).toEqual(status);
  });
  it("documents the legacy handoff projection instead of internal stage metadata", async () => {
    const document = await (await setup().app.request("/openapi.json")).json();
    for (const route of ["/v1/integrations/{provider}/connect", "/v1/email/connect", "/v1/linkedin/connect"]) {
      const schema = document.paths[route].post.responses[200].content["application/json"].schema;
      expect(JSON.stringify(schema)).not.toContain('"expires_at"');
      expect(JSON.stringify(schema)).not.toContain('"attempt_ref"');
      expect(JSON.stringify(schema)).toContain('"connect_url"');
    }
  });
});
