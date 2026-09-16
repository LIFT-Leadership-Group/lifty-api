import { describe, expect, it } from "vitest";
import { createLinkedinConnectOperations } from "../src/linkedin-connect.js";
import { sealLinkedinIntent, linkedinCallbackName } from "../src/linkedin-state.js";

const id = "11111111-1111-4111-8111-111111111111", workspace = "22222222-2222-4222-8222-222222222222", connection = "33333333-3333-4333-8333-333333333333";
const key = "linkedin-server-key-" + "x".repeat(40), state = sealLinkedinIntent(id, key);
const settings = { dsn: "https://api1.unipile.com:13111", accessToken: "provider-SECRET", serverKey: key, publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://project.supabase.co", publishableKey: "sb_public" };
const timezone = "America/Argentina/Buenos_Aires";
const body = { status: "CREATION_SUCCESS", account_id: "account_1", name: linkedinCallbackName(id, key) };
const account = { object: "Account", id: "account_1", type: "LINKEDIN", connection_params: { im: { id: "ACoFounder" } }, sources: [{ id: "source", status: "OK" }] };
const owner = { object: "AccountOwnerProfile", provider: "LINKEDIN", provider_id: "ACoFounder", first_name: "Founder", last_name: "Example", public_identifier: "founder" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function harness(options: { initial?: string; intentState?: string; pinnedAccount?: string; pinnedProfile?: string; hint?: string | null; hintWorkspace?: string; providerStatus?: number; source?: string; owner?: unknown; rpcError?: unknown; hintError?: unknown; outbound?: boolean } = {}) {
  let current = options.initial ?? "pending", intentState = options.intentState ?? "ready", hint = options.hint === undefined ? "account_1" : options.hint;
  let outbound = options.outbound ?? false, health = options.initial === "connected" ? "running" : "unknown", failed: string | null = null;
  const events: string[] = [], calls: { operation: string; payload: Record<string, unknown>; caller: boolean }[] = [];
  const stored = () => ({ state: current, workspace_ref: workspace, connection_ref: current === "connected" || current === "disconnected" ? connection : null, account_id: current === "connected" || current === "disconnected" ? "account_1" : null,
    profile_id: current === "connected" || current === "disconnected" ? "ACoFounder" : null, profile_url: null, display_name: null, timezone,
    intent_ref: current === "pending" ? id : null, failure_code: failed, outbound_enabled: outbound, health_status: health, expires_at: new Date(Date.now() + 600_000).toISOString() });
  const intent = () => ({ state: intentState, intent_ref: id, workspace_ref: workspace, expires_at: new Date(Date.now() + 600_000).toISOString(), account_id: options.pinnedAccount ?? null, profile_id: options.pinnedProfile ?? null, hosted_url: intentState === "ready" ? "https://account.unipile.com/opaque" : null, timezone });
  async function rpc(name: string, args: Record<string, unknown>, caller: boolean): Promise<{ data: unknown; error: unknown }> {
    const operation = String(args.p_operation), payload = args.p_payload as Record<string, unknown>;
    expect(args.p_server_key).toBe(key); events.push(`${caller ? "jwt" : "server"}:${name}:${operation}`); calls.push({ operation, payload, caller });
    if (caller && options.rpcError) return { data: null, error: options.rpcError };
    if (name === "lifty_linkedin_callback_hint") {
      if (options.hintError) return { data: null, error: options.hintError };
      if (operation === "read") return { data: { workspace_ref: options.hintWorkspace ?? workspace, intent_ref: id, account_id: hint }, error: null };
      expect(operation).toBe("record"); hint = String(payload.account_id); return { data: { ok: true }, error: null };
    }
    expect(name).toBe("lifty_linkedin_connection");
    if (operation === "intent") return { data: intent(), error: null };
    if (operation === "issue_link") { const claimed = intentState === "pending"; if (claimed) intentState = "issuing"; return { data: { claimed }, error: null }; }
    if (operation === "save_link") { intentState = "ready"; return { data: { ok: true }, error: null }; }
    if (operation === "complete") {
      if (intentState === "completed") return { data: { ok: true }, error: null };
      expect(payload).toMatchObject({ intent_ref: id, account_id: "account_1", profile_id: "ACoFounder" });
      current = "connected"; health = "running"; outbound = false; intentState = "completed";
      return { data: { ok: true }, error: null };
    }
    if (operation === "fail") { failed = String(payload.failure_code); current = "failed"; intentState = "failed"; }
    if (operation === "health") {
      expect(caller).toBe(true); expect(payload).toMatchObject({ workspace: "senja", connection_ref: connection, account_id: "account_1", profile_id: "ACoFounder" });
      health = String(payload.status); if (health !== "running") { current = "disconnected"; outbound = false; }
    }
    if (operation === "disconnect") { expect(payload).toEqual({ workspace: "senja", confirm: true }); current = "disconnected"; outbound = false; }
    if (operation === "start" && current !== "connected") { current = "pending"; intentState = "pending"; }
    return { data: stored(), error: null };
  }
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === "api1.unipile.com") {
      events.push(target.pathname);
      if (target.pathname.endsWith("/hosted/accounts/link")) return json({ object: "HostedAuthUrl", url: "https://account.unipile.com/opaque" });
      if (target.pathname.endsWith("/users/me")) return json(options.owner ?? owner);
      return json({ ...account, sources: [{ id: "source", status: options.source ?? "OK" }] }, options.providerStatus ?? 200);
    }
    expect(init?.headers).toMatchObject({ apikey: "sb_public" });
    expect(JSON.stringify(init?.headers)).not.toContain("Bearer");
    const result = await rpc(target.pathname.split("/").at(-1)!, JSON.parse(String(init?.body)), false);
    return json(result.error ?? result.data, result.error ? 409 : 200);
  };
  const session = { userId: id, client: { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args, true) } };
  return { ops: createLinkedinConnectOperations({ ...settings, fetchImpl }), session, events, calls };
}

describe("LinkedIn connection lifecycle", () => {
  it("creates a signed browser handoff through the caller JWT without contacting Unipile", async () => {
    const h = harness({ initial: "not_connected" });
    const result = await h.ops.start(h.session, { workspace: "senja", timezone, account_use: "personal", other_automation: false });
    expect(result).toMatchObject({ status: "pending", sending_enabled: false, profile_id: null });
    expect("connect_url" in result && result.connect_url).toMatch(/^https:\/\/api.lifty.test\/unipile\/linkedin\/start\?intent=/);
    expect(h.events).toEqual(["jwt:lifty_linkedin_connection:start"]);
  });
  it("rejects other automation, nonhabitual account and arbitrary timezone before RPC", async () => {
    const h = harness();
    for (const input of [{ other_automation: true }, { account_use: "outreach" }, { timezone: "+03:00" }, { timezone: "Not/AZone" }]) {
      await expect(h.ops.start(h.session, { workspace: "senja", timezone, account_use: "personal", other_automation: false, ...input } as never)).rejects.toThrow();
    }
    expect(h.events).toEqual([]);
  });
  it("records the bound callback hint before authenticated account and owner readback", async () => {
    const h = harness(); await h.ops.callback(state, body);
    expect(h.events).toEqual(["server:lifty_linkedin_connection:intent", "server:lifty_linkedin_callback_hint:record", "/api/v1/accounts/account_1", "/api/v1/users/me", "server:lifty_linkedin_connection:complete"]);
  });
  it.each([{ ...body, name: "a".repeat(64) }, { ...body, status: "OK" }, { ...body, account_id: "../foreign" }])("rejects forged callback before RPC: %j", async callback => {
    const h = harness(); await expect(h.ops.callback(state, callback)).rejects.toMatchObject({ code: "LINKEDIN_CALLBACK_INVALID" }); expect(h.events).toEqual([]);
  });
  it("rejects a different reconnect account before hint or provider read", async () => {
    const h = harness({ pinnedAccount: "account_foreign" });
    await expect(h.ops.callback(state, body)).rejects.toMatchObject({ code: "LINKEDIN_IDENTITY_MISMATCH" });
    expect(h.events).toHaveLength(1);
  });
  it("rejects mismatching verified reconnect profile and never completes", async () => {
    const h = harness({ pinnedProfile: "ACoOther" });
    await expect(h.ops.callback(state, body)).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_IDENTITY_MISMATCH" });
    expect(h.calls.some(call => call.operation === "complete")).toBe(false);
    expect(h.calls.at(-1)?.payload.failure_code).toBe("identity_mismatch");
  });
  it("retains a durable hint when the provider is temporarily unavailable", async () => {
    const h = harness({ providerStatus: 503 });
    await expect(h.ops.callback(state, body)).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
    expect(h.calls.map(call => call.operation)).toEqual(["intent", "record"]);
  });
  it("reconciles a member-authorized hint on status and never activates sending", async () => {
    const h = harness();
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ status: "connected", sending_enabled: false, profile_id: "ACoFounder" });
    expect(h.events.slice(0, 6)).toEqual(["jwt:lifty_linkedin_connection:status", "jwt:lifty_linkedin_callback_hint:read", "/api/v1/accounts/account_1", "/api/v1/users/me", "server:lifty_linkedin_connection:complete", "jwt:lifty_linkedin_connection:status"]);
    expect(h.calls.filter(call => call.operation === "complete")).toHaveLength(1);
  });
  it.each([{ hint: null }, { providerStatus: 404 }, { source: "CONNECTING" }])("keeps pending without a usable hint or ready provider: %j", async options => {
    const h = harness(options);
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ status: "pending", sending_enabled: false });
    expect(h.calls.some(call => ["complete", "fail"].includes(call.operation))).toBe(false);
  });
  it.each(["pending", "connected"] as const)("leaves %s authorization/grant unchanged when provider health is unavailable", async initial => {
    const h = harness({ initial, providerStatus: 503 });
    await expect(h.ops.status(h.session, "senja")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
    expect(h.calls.some(call => ["health", "fail", "complete", "disconnect"].includes(call.operation))).toBe(false);
  });
  it.each([{ hintWorkspace: connection }, { rpcError: { code: "PT403", message: "linkedin_workspace_forbidden" } }, { hintError: { code: "PT403", message: "linkedin_callback_invalid" } }])("rejects foreign or revoked hint before provider reads: %j", async options => {
    const h = harness(options); await expect(h.ops.status(h.session, "senja")).rejects.toBeDefined();
    expect(h.events.some(event => event.startsWith("/api"))).toBe(false);
  });
  it("persists unhealthy readback and stops outbound instead of only changing display status", async () => {
    const h = harness({ initial: "connected", source: "CREDENTIALS", outbound: true });
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ status: "disconnected", health_status: "credentials", sending_enabled: false });
    expect(h.calls.find(call => call.operation === "health")?.payload.status).toBe("credentials");
  });
  it("healthy readback of a paused connection never enables outbound", async () => {
    const h = harness({ initial: "connected", outbound: false });
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ status: "connected", sending_enabled: false });
    expect(h.calls.map(call => call.operation)).not.toContain("activate");
  });
  it("disconnects through member JWT and never calls the provider", async () => {
    const h = harness({ initial: "connected", outbound: true });
    expect(await h.ops.disconnect(h.session, "senja")).toMatchObject({ status: "disconnected", sending_enabled: false });
    expect(h.events).toEqual(["jwt:lifty_linkedin_connection:disconnect", "jwt:lifty_linkedin_connection:status"]);
  });
  it("reports already active health truthfully without activating or reconnecting", async () => {
    const h = harness({ initial: "connected", outbound: true });
    expect(await h.ops.start(h.session, { workspace: "senja", timezone, account_use: "personal", other_automation: false })).toMatchObject({ status: "connected", sending_enabled: true, connection_ref: connection });
    expect(h.calls.map(call => call.operation)).toEqual(["start", "health", "status"]);
  });
  it("replayed completed callbacks cannot reactivate a disconnected connection", async () => {
    const h = harness({ initial: "disconnected", intentState: "completed", pinnedAccount: "account_1", pinnedProfile: "ACoFounder" });
    await h.ops.callback(state, { ...body, status: "RECONNECTED" });
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ status: "disconnected", sending_enabled: false });
    expect(h.calls.some(call => call.operation === "activate")).toBe(false);
  });
  it("claims a hosted link once across concurrent browser loads", async () => {
    const h = harness({ intentState: "pending" });
    const results = await Promise.allSettled([h.ops.authorize(state), h.ops.authorize(state)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(h.events.filter(event => event === "/api/v1/hosted/accounts/link")).toHaveLength(1);
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.events.filter(event => event === "/api/v1/hosted/accounts/link")).toHaveLength(1);
  });
});

describe("LinkedIn exact-attempt and transient verification", () => {
  it.each(["pending", "connected"])("does not mutate a %s connection after an incomplete owner read", async initial => {
    const h = harness({ initial, owner: { object: "AccountOwnerProfile", provider: "LINKEDIN" } });
    await expect(h.ops.status(h.session, "senja", initial === "pending" ? id : undefined)).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
    expect(h.calls.some(call => ["health", "fail", "complete", "disconnect"].includes(call.operation))).toBe(false);
  });
  it("does not reconcile a different latest pending attempt as the requested one", async () => {
    const h = harness();
    expect((await h.ops.status(h.session, "senja", workspace)).status).toBe("pending");
    expect(h.calls.map(call => call.operation)).toEqual(["status"]);
  });
});

describe("provider access and source reads remain unverified", () => {
  it.each([{ providerStatus: 401 }, { providerStatus: 403 }, { source: "" }, { source: "FUTURE_STATUS" }])("preserves a healthy grant and pending attempt for failed evidence %j", async options => {
    for (const initial of ["connected", "pending"]) {
      const h = harness({ initial, ...options, outbound: true });
      await expect(h.ops.status(h.session, "senja")).rejects.toMatchObject({ code: "UNIPILE_LINKEDIN_UNAVAILABLE" });
      expect(h.calls.some(call => ["health", "fail", "complete", "disconnect"].includes(call.operation))).toBe(false);
    }
  });
});
