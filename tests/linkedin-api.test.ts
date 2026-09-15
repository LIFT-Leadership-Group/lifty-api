import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { LINKEDIN_POLICY } from "../src/linkedin-contracts.js";

const userId = "11111111-1111-4111-8111-111111111111", workspace = "22222222-2222-4222-8222-222222222222";
const connect = { workspace: "senja", timezone: "America/Argentina/Buenos_Aires", account_use: "personal", other_automation: false };
const authenticate = async () => ({ ok: true as const, session: { userId, client: {} } });
const post = (payload: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const pending = { provider: "unipile" as const, channel: "linkedin" as const, workspace_ref: workspace, status: "pending" as const, timezone: connect.timezone,
  account_use: "personal" as const, other_automation: false as const, profile_id: null, profile_url: null, display_name: null, policy: LINKEDIN_POLICY,
  health_status: "unknown" as const, sending_enabled: false as const, connect_url: "https://api.lifty.test/unipile/linkedin/start?intent=opaque", intent_ref: userId, expires_in_seconds: 600 };
const env = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_public", SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json", HUBSPOT_CLIENT_ID: "client", HUBSPOT_CLIENT_SECRET: "secret", PUBLIC_BASE_URL: "https://api.lifty.test", TRIGGER_SECRET_KEY: "trigger" };

describe("LinkedIn public API", () => {
  it.each(["/v1/linkedin/connect", "/v1/linkedin/disconnect", "/v1/linkedin/campaign"])("authenticates before parsing %s", async path => {
    expect((await createApp().request(path, post({}))).status).toBe(401);
  });
  it("authenticates LinkedIn status", async () => { expect((await createApp().request("/v1/linkedin?workspace=senja")).status).toBe(401); });
  it("passes a strict connection declaration through the session boundary", async () => {
    const calls: unknown[] = [];
    const app = createApp({ authenticate, startLinkedinConnect: async (session, input) => { calls.push({ session, input }); return pending; } });
    const result = await app.request("/v1/linkedin/connect", post(connect));
    expect(result.status).toBe(200); expect(await result.json()).toEqual(pending);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([{ session: { userId, client: {} }, input: connect }]);
  });
  it.each([{ ...connect, other_automation: true }, { ...connect, note: "invite note" }, { workspace: "senja" }, { ...connect, timezone: "Mars/Olympus" }])("rejects unsafe declarations %j", async input => {
    const app = createApp({ authenticate });
    expect((await app.request("/v1/linkedin/connect", post(input))).status).toBe(400);
  });
  it("requires explicit disconnect confirmation and ignores no extra account selector", async () => {
    const app = createApp({ authenticate });
    for (const input of [{ workspace: "senja" }, { workspace: "senja", confirm: true, account_id: "foreign" }]) expect((await app.request("/v1/linkedin/disconnect", post(input))).status).toBe(400);
  });
  it("rejects status with extra selectors", async () => {
    const app = createApp({ authenticate });
    expect((await app.request("/v1/linkedin?workspace=senja&account_id=foreign")).status).toBe(400);
  });
  it("keeps unsupported operations and sequence extensions out of the RPC", async () => {
    const app = createApp({ authenticate });
    expect((await app.request("/v1/linkedin/campaign", post({ operation: "prepare", payload: { workspace: "senja", lead_id: userId, connection_ref: workspace, text: "Hello", steps: [] } }))).status).toBe(400);
  });
  it("rejects pending results that enable sending or contain provider data", async () => {
    for (const result of [{ ...pending, sending_enabled: true }, { ...pending, provider_token: "secret" }]) {
      const app = createApp({ authenticate, log: () => {}, startLinkedinConnect: async () => result as never });
      expect((await app.request("/v1/linkedin/connect", post(connect))).status).toBe(500);
    }
  });
  it("rejects contradictory connection health or outbound state", async () => {
    const { connect_url: _url, expires_in_seconds: _expires, ...base } = pending;
    for (const result of [
      { ...base, status: "disconnected", connection_ref: workspace, failure_code: null, sending_enabled: true },
      { ...base, status: "connected", connection_ref: workspace, failure_code: null, health_status: "running", profile_id: null },
      { ...base, status: "connected", connection_ref: workspace, failure_code: null, health_status: "credentials", profile_id: "ACoFounder" },
    ]) {
      const app = createApp({ authenticate, log: () => {}, getLinkedinConnection: async () => result as never });
      expect((await app.request("/v1/linkedin?workspace=senja")).status).toBe(500);
    }
  });
  it("bounds the callback and validates provider handoff origin", async () => {
    const app = createApp({ authorizeLinkedin: async () => "https://attacker.test/", log: () => {} });
    expect((await app.request("/unipile/linkedin/start?intent=x")).status).toBe(502);
    expect((await app.request("/unipile/linkedin/callback?intent=x", post({ data: "x".repeat(5000) }))).status).toBe(413);
  });
  it("documents authenticated strict schemas without credentials", async () => {
    const doc = await (await createApp().request("/openapi.json")).json();
    expect(doc.paths["/v1/linkedin/connect"].post.operationId).toBe("startLinkedinConnect");
    expect(doc.paths["/v1/linkedin/campaign"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/v1/linkedin/connect"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    expect(JSON.stringify(doc)).not.toMatch(/serverKey|accessToken/);
  });
});

describe("LinkedIn dedicated configuration", () => {
  it("supports LinkedIn independently of email without unrestricted Supabase secrets", () => {
    const key = "linkedin-key-" + "x".repeat(32);
    const config = loadConfig({ ...env, UNIPILE_DSN: "https://api1.unipile.com:13111", UNIPILE_ACCESS_TOKEN: "unipile", LIFTY_LINKEDIN_SERVER_KEY: key });
    expect(config.linkedin).toMatchObject({ serverKey: key, publishableKey: "sb_public" });
    expect(config.email).toBeNull();
  });
  it("does not enable LinkedIn just because email is configured", () => {
    expect(loadConfig({ ...env, UNIPILE_DSN: "https://api1.unipile.com:13111", UNIPILE_ACCESS_TOKEN: "unipile", LIFTY_EMAIL_SERVER_KEY: "email-key-" + "x".repeat(32) }).linkedin).toBeNull();
  });
  it("requires a dedicated valid key and both provider settings", () => {
    expect(() => loadConfig({ ...env, LIFTY_LINKEDIN_SERVER_KEY: "x".repeat(40) })).toThrow();
    expect(() => loadConfig({ ...env, UNIPILE_DSN: "https://api1.unipile.com:13111", UNIPILE_ACCESS_TOKEN: "unipile", LIFTY_LINKEDIN_SERVER_KEY: "short" })).toThrow();
    expect(() => loadConfig({ ...env, UNIPILE_DSN: "https://api1.unipile.com:13111", UNIPILE_ACCESS_TOKEN: "unipile", LIFTY_LINKEDIN_SERVER_KEY: "x".repeat(40), LIFTY_EMAIL_SERVER_KEY: "x".repeat(40) })).toThrow();
  });
});
