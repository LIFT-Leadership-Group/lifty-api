import { describe, expect, it } from "vitest";
import { createLinkedinProvider } from "../src/linkedin-provider.js";
import { sealLinkedinIntent, openLinkedinIntent, linkedinCallbackName, validLinkedinCallbackName } from "../src/linkedin-state.js";
import { sealEmailIntent, openEmailIntent, emailCallbackName } from "../src/email-state.js";

const secret = "linkedin-test-key-" + "x".repeat(40);
const intent = "11111111-1111-4111-8111-111111111111";
const settings = { dsn: "https://api1.unipile.com:13111", accessToken: "provider-SECRET" };
const account = { object: "Account", id: "account_1", type: "LINKEDIN", connection_params: { im: { id: "ACoFounder", publicIdentifier: "founder" } }, sources: [{ id: "source_1", status: "OK" }] };
const owner = { object: "AccountOwnerProfile", provider: "LINKEDIN", provider_id: "ACoFounder", public_identifier: "founder", first_name: "Founder", last_name: "Example", public_profile_url: "https://www.linkedin.com/in/founder/" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function provider(options: { account?: unknown; owner?: unknown; status?: number } = {}) {
  const requests: string[] = [];
  const adapter = createLinkedinProvider({ ...settings, fetchImpl: async (url, init) => {
    requests.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ "X-API-KEY": settings.accessToken });
    const target = new URL(String(url));
    if (target.pathname.endsWith("/users/me")) {
      expect(target.searchParams.get("account_id")).toBe("account_1");
      return json(options.owner ?? owner);
    }
    expect(target.pathname).toBe("/api/v1/accounts/account_1");
    return json(options.account ?? account, options.status ?? 200);
  } });
  return { adapter, requests };
}

describe("LinkedIn purpose-separated state", () => {
  it("authenticates intent and rejects email tokens and wrong key or purpose", () => {
    const state = sealLinkedinIntent(intent, secret);
    expect(openLinkedinIntent(state, secret)).toBe(intent);
    expect(() => openLinkedinIntent(state, secret + "other")).toThrow();
    expect(() => openLinkedinIntent(sealEmailIntent(intent, secret), secret)).toThrow();
    expect(() => openEmailIntent(state, secret)).toThrow();
    expect(validLinkedinCallbackName(intent, linkedinCallbackName(intent, secret), secret)).toBe(true);
    expect(validLinkedinCallbackName(intent, emailCallbackName(intent, secret), secret)).toBe(false);
  });
});

describe("LinkedIn provider readback", () => {
  it("binds both authenticated account and own profile, returning only selected identity evidence", async () => {
    const h = provider();
    expect(await h.adapter.readIdentity("account_1", "ACoFounder")).toEqual({ accountId: "account_1", profileId: "ACoFounder", profileUrl: owner.public_profile_url, displayName: "Founder Example", healthy: true, healthStatus: "running" });
    expect(h.requests).toHaveLength(2);
  });
  it.each([
    { account: { ...account, type: "GOOGLE_OAUTH" } },
    { account: { ...account, id: "foreign_account" } },
    { owner: { ...owner, provider: "GMAIL" } },
    { owner: { ...owner, object: "UserProfile" } },
    { owner: { ...owner, provider_id: "ACoOther" } },
    { owner: { ...owner, provider_id: "" } },
  ])("rejects account/profile identity mismatch: %j", async options => {
    await expect(provider(options).adapter.readIdentity("account_1", "ACoFounder")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_IDENTITY_MISMATCH" });
  });
  it("compares the current canonical profile against a reconnect pin", async () => {
    await expect(provider().adapter.readIdentity("account_1", "ACoPreviouslyBound")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_IDENTITY_MISMATCH" });
  });
  it.each([
    [[], "unknown"], [[{ id: "", status: "OK" }], "unknown"],
    [[{ id: "s", status: "OK" }, { id: "s", status: "OK" }], "unknown"],
    [[{ id: "s", status: "CREDENTIALS" }], "credentials"],
    [[{ id: "s", status: "CONNECTING" }], "unknown"],
    [[{ id: "s", status: "ERROR" }], "errored"],
  ])("keeps unhealthy or ambiguous source evidence inactive: %j", async (sources, healthStatus) => {
    const h = provider({ account: { ...account, sources } });
    expect(await h.adapter.readIdentity("account_1", "ACoFounder")).toMatchObject({ healthy: false, healthStatus });
    expect(h.requests).toHaveLength(1);
  });
  it("does not expose URLs outside LinkedIn, credential-bearing links or raw provider extras", async () => {
    const result = await provider({ owner: { ...owner, public_profile_url: "https://attacker.test/provider-SECRET", token: "provider-SECRET" } }).adapter.readIdentity("account_1");
    expect(result.profileUrl).toBe("https://www.linkedin.com/in/founder/");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("redacts provider failures and makes no retry", async () => {
    const h = provider({ status: 503, account: { error: "provider-SECRET" } });
    await expect(h.adapter.readIdentity("account_1")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
    expect(h.requests).toHaveLength(1);
  });
  it("bounds stalled response bodies", async () => {
    const adapter = createLinkedinProvider({ ...settings, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    await expect(adapter.readIdentity("account_1")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
  });
});

describe("LinkedIn hosted auth", () => {
  it.each(["HostedAuthUrl", "HostedAuthURL"])("creates a single-use LinkedIn-only link using %s", async object => {
    const bodies: unknown[] = [];
    const adapter = createLinkedinProvider({ ...settings, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ object, url: "https://account.unipile.com/opaque" });
    } });
    await adapter.createLink({ correlation: "bound-name", notifyUrl: "https://api.lifty.test/unipile/linkedin/callback", expiresAt: "2026-09-15T16:00:00.000Z", reconnectId: null });
    expect(bodies).toEqual([{ type: "create", providers: ["LINKEDIN"], api_url: "https://api1.unipile.com:13111", expiresOn: "2026-09-15T16:00:00.000Z", name: "bound-name", notify_url: "https://api.lifty.test/unipile/linkedin/callback", single_use: true }]);
  });
  it("pins a reconnect to the existing provider account", async () => {
    const adapter = createLinkedinProvider({ ...settings, fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ type: "reconnect", reconnect_account: "account_1" });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("providers");
      return json({ object: "HostedAuthUrl", url: "https://account.unipile.com/opaque" });
    } });
    await adapter.createLink({ correlation: "name", notifyUrl: "https://api.lifty.test/callback", expiresAt: "2026-09-15T16:00:00Z", reconnectId: "account_1" });
  });
  it.each(["https://attacker.test/", "https://account.unipile.com:444/x", "https://user:pass@account.unipile.com/x", "http://account.unipile.com/x"])("rejects unsafe handoff %s", async url => {
    const adapter = createLinkedinProvider({ ...settings, fetchImpl: async () => json({ object: "HostedAuthUrl", url }) });
    await expect(adapter.createLink({ correlation: "name", notifyUrl: "https://api.lifty.test/callback", expiresAt: "2026-09-15T16:00:00Z", reconnectId: null })).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_HOSTED_URL_INVALID" });
  });
});
