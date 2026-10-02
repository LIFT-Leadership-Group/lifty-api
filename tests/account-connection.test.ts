import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createProductionApp } from "../src/service.js";
import { createAccountConnection } from "../src/account-connection.js";
import { sealConnectAttempt } from "../src/connect-state.js";

// LIF-1182 sending-account connections through the production app: Lifty's
// connect page, the shared confirmation shell and access removal. Only the
// trusted database RPC and the provider HTTP API are replaced.
const emailKey = "e".repeat(40), linkedinKey = "l".repeat(40);
const env = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_public",
  SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client", HUBSPOT_CLIENT_SECRET: "secret", PUBLIC_BASE_URL: "https://api.lifty.test", TRIGGER_SECRET_KEY: "trigger",
  LIFTY_EMAIL_SERVER_KEY: emailKey, LIFTY_LINKEDIN_SERVER_KEY: linkedinKey,
  UNIPILE_V2_ACCESS_TOKEN: "v2-secret", UNIPILE_V2_APPLICATION_ID: "app_test", UNIPILE_V2_HOSTED_AUTH_ORIGINS: "https://connect.lifty.test",
};
const attemptId = "11111111-1111-4111-8111-111111111111";
const hostedLink = "https://connect.lifty.test/session-1";
const transport = { api_version: "v2", application_id: "app_test", account_scope_id: null, provider_namespace: "unipile:v2:app_test",
  hosted_auth_origin: "https://connect.lifty.test", account_id: null as string | null, generation: 0 };

type Db = ReturnType<typeof attemptDb>;
function attemptDb(channel: "email" | "linkedin" = "email") {
  return {
    channel, internal_state: "pending" as "pending" | "issuing" | "ready" | "completed" | "failed", state: "pending",
    reason: null as string | null, declaration: null as Record<string, unknown> | null, hosted_url: null as string | null,
    expected_identity: null as Record<string, string> | null, transport: { ...transport },
    authorization: { received: false, account_id: null as string | null, return_error: null as string | null },
    ops: [] as string[], payloads: {} as Record<string, Record<string, unknown>>,
  };
}
const snapshot = (db: Db, extra: Record<string, unknown> = {}) => ({
  attempt: { id: attemptId, workspace: { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example", state: "ready_for_connections" },
    sender: { id: "33333333-3333-4333-8333-333333333333", name: "Ana <Pérez>" }, channel: db.channel, reconnect: db.expected_identity !== null,
    account_id: null, expected_identity: db.expected_identity, internal_state: db.internal_state, state: db.state, reason: db.reason,
    declaration: db.declaration, declaration_required: true, issuer_user_id: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-10-02T12:00:00Z", expires_at: "2099-01-01T00:00:00Z", hosted_url: db.hosted_url },
  transport: db.transport,
  authorization: { ...db.authorization, event_id: null, at: null }, ...extra });

interface Provider { senders: string; accountStatus: number; deleteStatus: number; calls: string[]; bodies: Record<string, unknown>[] }
function stub(db: Db, provider: Partial<Provider> = {}) {
  const p: Provider = { senders: "ana@example.test", accountStatus: 200, deleteStatus: 200, calls: [], bodies: [], ...provider };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.unipile.com") {
      p.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v2/auth/link") { p.bodies.push(JSON.parse(String(init!.body))); return Response.json({ object: "HostedAuthLink", link: hostedLink }); }
      if (init?.method === "DELETE") return new Response("{}", { status: p.deleteStatus });
      if (p.accountStatus !== 200) return new Response("PRIVATE provider body", { status: p.accountStatus });
      if (url.pathname.endsWith("/email-senders")) return Response.json({ data: [{ object: "EmailSender", email: p.senders, is_primary: true, verification_status: "verified" }] });
      return Response.json({ object: "Account", id: "acc_new", application_id: "app_test", account_scope_id: null, user_id: "user-1",
        provider: "google", status: "running", is_locked: false, metadata: { products_connection_status: { gmail: "running" } } });
    }
    expect(url.toString()).toBe("https://project.supabase.co/rest/v1/rpc/lifty_sending_account_provider");
    const body = JSON.parse(String(init!.body));
    expect(body.p_server_key).toBe(db.channel === "email" ? emailKey : linkedinKey);
    const op = body.p_operation as string, payload = body.p_payload as Record<string, unknown>;
    db.ops.push(op); db.payloads[op] = payload;
    if (op === "declare") db.declaration = payload.declaration as Record<string, unknown>;
    if (op === "issue_link") {
      const claimed = db.internal_state === "pending";
      if (claimed) db.internal_state = "issuing";
      return Response.json(snapshot(db, { claimed }));
    }
    if (op === "save_link") { db.internal_state = "ready"; db.hosted_url = String(payload.url); }
    if (op === "return_error") db.authorization.return_error = String(payload.return_error);
    if (op === "fail") { db.internal_state = "failed"; db.state = "failed"; db.reason = String(payload.reason); }
    if (op === "complete") { db.internal_state = "completed"; db.state = "connected"; }
    return Response.json(snapshot(db));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, provider: p };
}
const app = () => createProductionApp(loadConfig(env));
const intent = (channel: "email" | "linkedin" = "email") => sealConnectAttempt(channel, attemptId, channel === "email" ? emailKey : linkedinKey);
const form = (body: string, origin = "https://api.lifty.test") => ({ method: "POST",
  headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body });
const status = (channel: string, state: string, errorType?: string) => ({ method: "POST",
  headers: { origin: "https://api.lifty.test", "content-type": "application/json", "x-lifty-connection": "1" },
  body: JSON.stringify({ state, ...(errorType ? { errorType } : {}) }) });

afterEach(() => vi.unstubAllGlobals());

describe("Lifty connect page", () => {
  it("asks the declaration before any sign-in link, then issues exactly one link for repeated visits", async () => {
    const db = attemptDb(); const { provider } = stub(db); const server = app(); const state = intent();
    const page = await server.request(`/connect/email?intent=${encodeURIComponent(state)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/connect/email"');
    expect(html).toContain("Ana &lt;Pérez&gt;");
    expect(html).not.toMatch(/unipile/i);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://connect.lifty.test");
    expect(db.ops).toEqual(["context"]); expect(provider.calls).toEqual([]);

    const declared = await server.request("/connect/email", form(`intent=${encodeURIComponent(state)}&mailbox_use=dedicated`));
    expect(declared.status).toBe(303);
    expect(declared.headers.get("location")).toBe(hostedLink);
    expect(db.declaration).toEqual({ mailbox_use: "dedicated" });
    // The state is persisted before the provider creates the link.
    expect(db.ops).toEqual(["context", "declare", "issue_link", "auth_state", "save_link"]);
    expect(provider.bodies).toEqual([expect.objectContaining({ providers: ["google"], domain: "connect.lifty.test",
      redirect_uri: `https://api.lifty.test/connect/email/return?intent=${encodeURIComponent(state)}`, state: db.payloads.auth_state!.state })]);

    for (let visit = 0; visit < 2; visit++) {
      const again = await server.request(`/connect/email?intent=${encodeURIComponent(state)}`);
      expect(again.headers.get("location")).toBe(hostedLink);
    }
    expect(provider.calls).toEqual(["POST /v2/auth/link"]);
  });

  it("requires both LinkedIn confirmations and reconnects the pinned provider account", async () => {
    const db = attemptDb("linkedin"); db.transport.account_id = "acc_pinned"; db.expected_identity = { profile_id: "ACoAA" };
    const { provider } = stub(db); const server = app(); const state = encodeURIComponent(intent("linkedin"));
    expect((await server.request("/connect/linkedin", form(`intent=${state}&habitual_personal_account=yes`))).status).toBe(400);
    expect(db.ops).toEqual([]);
    const response = await server.request("/connect/linkedin", form(`intent=${state}&habitual_personal_account=yes&no_other_automation=yes`));
    expect(response.headers.get("location")).toBe(hostedLink);
    expect(db.declaration).toEqual({ habitual_personal_account: true, no_other_automation: true });
    expect(provider.bodies[0]).toMatchObject({ account_id: "acc_pinned" });
    expect(provider.bodies[0]).not.toHaveProperty("providers");
  });

  it("rejects forged, cross-channel, malformed and cross-origin requests before any database or provider call", async () => {
    const db = attemptDb(); const { fetchImpl } = stub(db); const server = app();
    const email = intent();
    for (const path of [`/connect/linkedin?intent=${encodeURIComponent(email)}`, `/connect/email?intent=${encodeURIComponent(email.slice(0, -2) + "AA")}`,
      `/connect/email?intent=${encodeURIComponent(email)}&intent=${encodeURIComponent(email)}`, `/connect/email?intent=${encodeURIComponent(email)}&next=x`]) {
      expect((await server.request(path)).status, path).toBe(400);
    }
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=habitual`, "https://evil.test"))).status).toBe(403);
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=personal`))).status).toBe(400);
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=habitual&email=a@b.test`))).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["https://evil.test/session", "https://account.unipile.com/session", "http://connect.lifty.test/session", "https://connect.lifty.test:8443/session"])(
    "never redirects to a stored sign-in URL outside Lifty's hosted origins: %s", async target => {
      const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = target;
      stub(db); const response = await app().request(`/connect/email?intent=${encodeURIComponent(intent())}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain(target);
    });

  it("acknowledges an authorization already received instead of issuing another link", async () => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.authorization.received = true;
    const { provider } = stub(db); const state = intent();
    const response = await app().request(`/connect/email?intent=${encodeURIComponent(state)}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/connect/email/return?intent=${encodeURIComponent(state)}`);
    expect(db.ops).toEqual(["context"]); expect(provider.calls).toEqual([]);
  });
  it.each(["provider", "save_link"])("keeps a lost %s response pending and never reissues the claimed link", async lost => {
    const db = attemptDb();
    const { fetchImpl, provider } = stub(db);
    const original = fetchImpl.getMockImplementation()!;
    let dropped = false;
    fetchImpl.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      const target = lost === "provider" ? String(input).endsWith("/auth/link")
        : String(init?.body).includes('"p_operation":"save_link"');
      if (target && !dropped) { dropped = true; throw new DOMException("response lost", "TimeoutError"); }
      return response;
    });
    const server = app();
    const response = await server.request("/connect/email", form(`intent=${encodeURIComponent(intent())}&mailbox_use=habitual`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/connect/email/return?intent=");
    expect(db.ops).not.toContain("fail");
    expect(db.state).toBe("pending");
    await server.request(`/connect/email?intent=${encodeURIComponent(intent())}`);
    expect(provider.calls).toEqual(["POST /v2/auth/link"]);
  });

});

describe("shared confirmation for sending accounts", () => {
  it("treats a browser error as a hint and completes only a signed authorization with verified identity", async () => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = hostedLink;
    const { provider } = stub(db); const server = app(); const state = intent();
    const shell = await server.request(`/connect/email/return?intent=${encodeURIComponent(state)}&error_type=canceled`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Checking your connection");
    const hinted = await server.request("/connect/email/return/status", status("email", state, "canceled"));
    expect(await hinted.json()).toEqual({ status: "pending" });
    expect(db.ops).toEqual(["context", "return_error"]);
    expect(db.state).toBe("pending");
    // The signed authorization arrives later (another tab): it wins.
    db.authorization = { received: true, account_id: "acc_new", return_error: "authorization_cancelled" };
    const confirmed = await server.request("/connect/email/return/status", status("email", state, "canceled"));
    expect(await confirmed.json()).toEqual({ status: "connected", account: null });
    expect(db.payloads.complete).toEqual({ attempt_id: attemptId, verified: { api_version: "v2", application_id: "app_test",
      account_scope_id: null, account_id: "acc_new", user_id: "user-1", email: "ana@example.test" } });
    expect(provider.calls).toEqual(["GET /v2/accounts/acc_new", "GET /v2/acc_new/email-senders"]);
  });

  it("fails a reconnect authorized by another mailbox and keeps provider outages pending", async () => {
    const mismatch = attemptDb(); mismatch.expected_identity = { email: "ana@example.test" };
    mismatch.authorization = { received: true, account_id: "acc_new", return_error: null };
    stub(mismatch, { senders: "someone-else@example.test" });
    const failed = await app().request("/connect/email/return/status", status("email", intent()));
    expect(await failed.json()).toEqual({ status: "failed", reason: "verification" });
    expect(mismatch.payloads.fail).toEqual({ attempt_id: attemptId, reason: "identity_mismatch" });
    expect(mismatch.ops).not.toContain("complete");

    const outage = attemptDb(); outage.authorization = { received: true, account_id: "acc_new", return_error: null };
    stub(outage, { accountStatus: 503 });
    const pending = await app().request("/connect/email/return/status", status("email", intent()));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    expect(outage.ops).toEqual(["context"]);
  });
});

describe("access removal", () => {
  const settings = (fetchImpl: typeof fetch) => createAccountConnection({ publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://project.supabase.co",
    publishableKey: "sb_public", serverKeys: { email: emailKey, linkedin: linkedinKey }, fetchImpl,
    provider: { v2: { accessToken: "v2-secret", applicationId: "app_test", hostedAuthOrigins: ["https://connect.lifty.test"] },
      v1: { dsn: "https://api1.unipile.com:13111", accessToken: "v1-secret" }, fetchImpl } });
  const blocked = (id: string, channel = "email") => ({ id, sender_id: "33333333-3333-4333-8333-333333333333", channel, identity: null,
    status: "disconnected", state: "paused", checked_at: null, observation: { state: "verified" }, connected_at: null,
    disconnected_at: "2026-10-02T12:00:00Z", access_revoked_at: null, declaration: null, sends: { today: 0, last_7_days: 0 } }) as const;

  it("confirms only with provider evidence, skips unsupported providers and stops at the shared deadline", async () => {
    const confirmed: unknown[] = [], provider: string[] = [];
    const contexts: Record<string, unknown> = {
      "a0000000-0000-4000-8000-000000000001": { revocable: true, transport: { ...transport, account_id: "acc_gone" } },
      "a0000000-0000-4000-8000-000000000002": { revocable: false, reason: "unsupported_provider", transport: null },
      "a0000000-0000-4000-8000-000000000003": { revocable: true, transport: { ...transport, api_version: "v1", account_id: "v1_account" } },
    };
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("unipile.com")) {
        provider.push(`${init?.method} ${url.origin}${url.pathname}`);
        return new Response("{}", { status: url.pathname.includes("acc_gone") ? 404 : 200 });
      }
      const body = JSON.parse(String(init!.body));
      if (body.p_operation === "revocation_context") return Response.json(contexts[body.p_payload.account_id]);
      confirmed.push(body.p_payload);
      // The shared budget ends after the first confirmation.
      controller.abort();
      return Response.json({ account: {} });
    }) as typeof fetch;
    await settings(fetchImpl).revoke(["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003"]
      .map(id => blocked(id)) as never, controller.signal);
    expect(provider).toEqual(["DELETE https://api.unipile.com/v2/accounts/acc_gone"]);
    expect(confirmed).toEqual([{ account_id: "a0000000-0000-4000-8000-000000000001", provider_account_id: "acc_gone", evidence: "not_found" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    provider.length = 0; confirmed.length = 0;
    await settings(fetchImpl).revoke([blocked("a0000000-0000-4000-8000-000000000003")] as never, new AbortController().signal);
    expect(provider).toEqual(["DELETE https://api1.unipile.com:13111/api/v1/accounts/v1_account"]);
    expect(confirmed).toEqual([{ account_id: "a0000000-0000-4000-8000-000000000003", provider_account_id: "v1_account", evidence: "deleted" }]);

    const none = vi.fn() as unknown as typeof fetch;
    await settings(none).revoke([blocked("a0000000-0000-4000-8000-000000000001")] as never, AbortSignal.abort());
    expect(none).not.toHaveBeenCalled();
  });

  it("never confirms when the provider refuses or the deadline expires mid-request", async () => {
    const operations: string[] = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("unipile.com")) {
        controller.abort();
        return new Promise<Response>((_resolve, reject) => init!.signal!.aborted ? reject(new Error("aborted"))
          : init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      const body = JSON.parse(String(init!.body)); operations.push(body.p_operation);
      return Response.json({ revocable: true, transport: { ...transport, account_id: "acc_slow" } });
    }) as typeof fetch;
    await settings(fetchImpl).revoke([blocked("a0000000-0000-4000-8000-000000000001"), blocked("a0000000-0000-4000-8000-000000000002")] as never, controller.signal);
    expect(operations).toEqual(["revocation_context"]);
  });
});
