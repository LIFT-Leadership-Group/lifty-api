import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createProductionApp } from "../src/service.js";
import { sealEmailIntent } from "../src/email-state.js";
import { sealLinkedinIntent } from "../src/linkedin-state.js";

const origin = "https://connect.liftygtm.com";
const canonical = "https://account.unipile.com/opaque%2Fsession%3D?locale=en&value=a%2Bb";
const branded = "https://connect.liftygtm.com/opaque%2Fsession%3D?locale=en&value=a%2Bb";
const env = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_public",
  SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client", HUBSPOT_CLIENT_SECRET: "secret", PUBLIC_BASE_URL: "https://api.lifty.test",
  TRIGGER_SECRET_KEY: "trigger", UNIPILE_DSN: "https://api1.unipile.com:13111", UNIPILE_ACCESS_TOKEN: "provider-secret",
  LIFTY_EMAIL_SERVER_KEY: "email-key-" + "x".repeat(32), LIFTY_LINKEDIN_SERVER_KEY: "linkedin-key-" + "x".repeat(32),
};
const routes = [
  ["/unipile/start?intent=opaque", undefined],
  ["/unipile/linkedin/start?intent=opaque", undefined],
  ["/unipile/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "intent=opaque&mailbox_use=personal" }],
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("hosted connection branding", () => {
  it.each(routes)("rewrites only the hostname for %s", async (path, init) => {
    const app = createApp({ unipileHostedAuthOrigin: origin, authorizeEmail: async () => canonical,
      authorizeLinkedin: async () => canonical, declareEmail: async () => canonical });
    const response = await app.request(path, init);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(branded);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each(routes)("keeps the standard domain when branding is not configured for %s", async (path, init) => {
    const app = createApp({ authorizeEmail: async () => canonical, authorizeLinkedin: async () => canonical, declareEmail: async () => canonical });
    const response = await app.request(path, init);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(canonical);
  });

  it.each([
    "https://account.unipile.com.evil.test/session", "https://account.unipile.com@evil.test/session",
    "http://account.unipile.com/session", "https://account.unipile.com:8443/session",
    "https://user:secret@account.unipile.com/session", "https://account.unipile.com/session#fragment",
    "https://connect.liftygtm.com/session", "https://evil.test/session", "not a url",
  ])("does not turn an untrusted stored URL into a branded redirect: %s", async target => {
    const app = createApp({ unipileHostedAuthOrigin: origin, log: () => {}, authorizeEmail: async () => target,
      authorizeLinkedin: async () => target, declareEmail: async () => target });
    for (const [path, init] of routes) {
      const response = await app.request(path, init);
      expect(response.status).toBe(502);
      expect(response.headers.get("location")).toBeNull();
      expect(JSON.stringify(await response.json())).not.toContain(target);
    }
  });

  it.each([
    "http://connect.liftygtm.com", "https://user:secret@connect.liftygtm.com", "https://connect.liftygtm.com:8443",
    "https://connect.liftygtm.com/path", "https://connect.liftygtm.com?x=1", "https://connect.liftygtm.com#x",
    "https://localhost", "https://127.0.0.1", "https://[::1]", "https://*.liftygtm.com", "not a url",
  ])("fails configuration before serving an unsafe hosted origin: %s", value => {
    expect(() => loadConfig({ ...env, UNIPILE_HOSTED_AUTH_ORIGIN: value })).toThrow(/UNIPILE_HOSTED_AUTH_ORIGIN/);
  });

  it.each(["email", "linkedin"] as const)("uses configured branding for new and cached %s links without changing durable storage", async channel => {
    for (const reconnect of [false, true]) {
      const id = "11111111-1111-4111-8111-111111111111";
      const intent = { state: "pending", intent_ref: id, workspace_ref: "22222222-2222-4222-8222-222222222222",
        expires_at: new Date(Date.now() + 600_000).toISOString(), account_id: reconnect ? "account_1" : null,
        profile_id: reconnect ? "profile_1" : null, email: "founder@example.test", timezone: "America/Argentina/Buenos_Aires",
        hosted_url: null as string | null };
      const providerBodies: Record<string, unknown>[] = [];
      const saved: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body));
        const json = (value: unknown) => Response.json(value);
        if (url.origin === "https://api1.unipile.com:13111") {
          expect(url.pathname).toBe("/api/v1/hosted/accounts/link");
          providerBodies.push(body);
          return json({ object: "HostedAuthUrl", url: canonical });
        }
        expect(url.origin).toBe("https://project.supabase.co");
        if (body.p_operation === "intent") return json(intent);
        if (body.p_operation === "issue_link") { intent.state = "issuing"; return json({ claimed: true }); }
        if (body.p_operation === "save_link") {
          expect(body.p_payload.url).toBe(canonical);
          saved.push(body.p_payload.url); intent.hosted_url = body.p_payload.url; intent.state = "ready";
          return json({ ok: true });
        }
        throw new Error("Unexpected RPC");
      });
      const config = loadConfig({ ...env, UNIPILE_HOSTED_AUTH_ORIGIN: origin + "/" });
      const app = createProductionApp(config);
      const state = channel === "email" ? sealEmailIntent(id, env.LIFTY_EMAIL_SERVER_KEY) : sealLinkedinIntent(id, env.LIFTY_LINKEDIN_SERVER_KEY);
      const path = channel === "email" ? "/unipile/start" : "/unipile/linkedin/start";
      for (let visit = 0; visit < 2; visit++) {
        const response = await app.request(`${path}?intent=${encodeURIComponent(state)}`);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(branded);
      }
      expect(saved).toEqual([canonical]);
      expect(providerBodies).toHaveLength(1);
      expect(providerBodies[0]).toMatchObject(reconnect ? { type: "reconnect", reconnect_account: "account_1" }
        : { type: "create", providers: channel === "email" ? ["GOOGLE", "OUTLOOK", "MAIL"] : ["LINKEDIN"] });
      // Turning branding off also works for intents that were issued while it was on.
      const rollback = createProductionApp(loadConfig(env));
      expect((await rollback.request(`${path}?intent=${encodeURIComponent(state)}`)).headers.get("location")).toBe(canonical);
      expect(providerBodies).toHaveLength(1);
    }
  });
});
