import { describe, expect, it } from "vitest";
import { createEmailWarmupOperations, presentWarmupStatus, readSignedFormUrl } from "../src/email-warmup.js";
import { WarmupStartResult, WarmupStatus, type StoredWarmupStatus } from "../src/email-warmup-contracts.js";
import { createCurrentClient as createApp } from "./current-client.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const binding = "33333333-3333-4333-8333-333333333333";
const sender = "44444444-4444-4444-8444-444444444444";
const user = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-22T15:00:00Z");
const expires = Math.floor(now.getTime() / 1000) + 3600;
const signedUrl = `https://app.mailivery.io/embed/form?tags=x&expires=${expires}&signature=SIGNATURE_SECRET_VALUE`;
const apiKey = "mailivery-KEY-secret-value-0123456789";
const snapshot = { status_code: "active", grade: "A", spf: "valid", dmarc: "valid", mx: "valid", domain_age: 400,
  warmup_duration_days: 12, emails_sent_today: 9, outreach_today: 6, response_today: 3, email_per_day_target: 15, connection_problem: false };

function stored(overrides: Partial<StoredWarmupStatus> = {}, bindingOverrides: Record<string, unknown> | null = {}): StoredWarmupStatus {
  return {
    workspace_ref: workspace, email: "founder@example.test", mailbox_use: "outreach", warmup_required: true, required_active_days: 21,
    binding: bindingOverrides === null ? null : { binding_ref: binding, sender_ref: sender, state: "warming", requested_action: null, blocking_reason: null,
      provider_campaign_bound: true, last_readback_at: "2026-09-22T14:00:00Z", snapshot, created_at: "2026-09-10T10:00:00Z", ...bindingOverrides } as StoredWarmupStatus["binding"],
    evidence: { active_duration_days: 12, healthy: true, passed: false, observed_at: "2026-09-22T14:00:00Z", fresh: true },
    outreach_unlocked: false,
    ...overrides,
  };
}

function harness(options: { data?: unknown; error?: unknown; key?: string | null; provider?: () => Response | Promise<Response> } = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const http: { url: string; init: RequestInit | undefined }[] = [];
  const session = { userId: user, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return options.error ? { data: null, error: options.error } : { data: options.data ?? stored(), error: null };
  } } };
  const fetchImpl: typeof fetch = async (url, init) => {
    http.push({ url: String(url), init });
    return options.provider ? options.provider() : new Response(JSON.stringify({ success: true, data: { url: signedUrl } }), { status: 200 });
  };
  const ops = createEmailWarmupOperations({ mailivery: options.key === null ? null : { apiKey: options.key ?? apiKey },
    fetchImpl, now: () => now, requestId: () => "req-1" });
  return { ops, session, rpcCalls, http };
}

describe("warmup status presentation", () => {
  it("maps an outreach mailbox in warmup to days, volume, checks and a projected go-live", () => {
    const status = presentWarmupStatus(stored(), now);
    expect(WarmupStatus.parse(status)).toEqual(status);
    expect(status).toMatchObject({ state: "warming", state_label: "Warming up", active_days: 12, required_active_days: 21,
      warmup_required: true, outreach_unlocked: false, today: { warmup_emails: 9, ramp_target: 15 },
      checks: { spf: "valid", dmarc: "valid", mx: "valid" }, last_checked_at: "2026-09-22T14:00:00Z", blocking_reason: null });
    expect(status.recommended_go_live).toMatchObject({ kind: "projected", date: "2026-10-01", remaining_active_days: 9 });
    expect(status.recommended_go_live.message).toContain("Paused days");
    expect(status.recommended_go_live.message).toContain("2026-10-01");
  });

  it("tells a personal mailbox that campaigns can run now and warmup is optional", () => {
    const status = presentWarmupStatus(stored({ mailbox_use: "personal", warmup_required: false, outreach_unlocked: null }), now);
    expect(status).toMatchObject({ warmup_required: false, outreach_unlocked: null,
      recommended_go_live: { kind: "now", date: "2026-09-22", remaining_active_days: null } });
    expect(status.recommended_go_live.message).toMatch(/Campaigns can run now\. Warmup is optional/);
  });

  it("reports an unlocked outreach mailbox only from the database predicate", () => {
    const unlocked = presentWarmupStatus(stored({ outreach_unlocked: true, evidence: { active_duration_days: 25, healthy: true, passed: true, observed_at: "2026-09-22T14:00:00Z", fresh: true } }), now);
    expect(unlocked.recommended_go_live).toMatchObject({ kind: "unlocked", date: "2026-09-22", remaining_active_days: 0 });
    // Enough days but no passing fresh check: no date is promised.
    const waiting = presentWarmupStatus(stored({ evidence: { active_duration_days: 22, healthy: true, passed: false, observed_at: "2026-09-20T14:00:00Z", fresh: false } }), now);
    expect(waiting.recommended_go_live).toMatchObject({ kind: "awaiting_check", date: null, remaining_active_days: 0 });
  });

  it("never projects earlier than the evidence allows when no evidence exists", () => {
    const status = presentWarmupStatus(stored({ evidence: null }, { state: "link_issued", provider_campaign_bound: false, snapshot: null, last_readback_at: null }), now);
    expect(status).toMatchObject({ state: "link_issued", active_days: 0, today: { warmup_emails: null, ramp_target: null },
      checks: { spf: "unknown", dmarc: "unknown", mx: "unknown" }, last_checked_at: null });
    expect(status.recommended_go_live).toMatchObject({ kind: "projected", date: "2026-10-13", remaining_active_days: 21 });
    expect(status.recommended_go_live.message).toMatch(/not running right now/);
  });

  it.each([
    ["paused", null, "Paused"],
    ["problem", "dns_invalid", "Needs attention"],
    ["pending_consent", "microsoft_consent_pending", "Waiting for Microsoft consent"],
    ["removed", null, "Removed"],
  ] as const)("describes %s in plain words and moves the date while not running", (state, reason, label) => {
    const status = presentWarmupStatus(stored({}, { state, blocking_reason: reason, snapshot: { ...snapshot, spf: "invalid", mx: null } }), now);
    expect(status.state_label).toBe(label);
    expect(status.checks).toEqual({ spf: "not_valid", dmarc: "valid", mx: "unknown" });
    if (reason) expect(status.blocking_reason).toMatchObject({ code: reason, message: expect.not.stringContaining("_") });
    expect(status.recommended_go_live.message).toMatch(/not running right now/);
  });

  it("covers an unconnected workspace and never exposes unknown database keys", () => {
    const status = presentWarmupStatus(stored({ email: null, mailbox_use: null, warmup_required: false, evidence: null, outreach_unlocked: null }, null), now);
    expect(status).toMatchObject({ state: "not_started", state_label: "Not started", requested_action: null,
      recommended_go_live: { kind: "connect_email", date: null } });
    expect(Object.keys(status)).not.toContain("binding");
    expect(JSON.stringify(status)).not.toContain(sender);
  });

  it("gives unknown blocking reasons a generic sentence", () => {
    const status = presentWarmupStatus(stored({}, { state: "problem", blocking_reason: "provider_quirk" }), now);
    expect(status.blocking_reason).toEqual({ code: "provider_quirk", message: expect.stringContaining("can't describe") });
  });
});

describe("warmup operations", () => {
  it("reads status through the founder RPC with only the workspace", async () => {
    const h = harness();
    await h.ops.status(h.session, "senja");
    expect(h.rpcCalls).toEqual([{ name: "lifty_email_warmup", args: { p_operation: "status", p_payload: { workspace: "senja" } } }]);
    expect(h.http).toHaveLength(0);
  });

  it("mints a tagged hosted form for a link_issued binding and reads expiry from the signed URL", async () => {
    const h = harness({ data: stored({ evidence: null }, { state: "link_issued", provider_campaign_bound: false, snapshot: null, last_readback_at: null }) });
    const result = await h.ops.start(h.session, "senja");
    expect(WarmupStartResult.parse(result)).toEqual(result);
    expect(h.rpcCalls.map(call => call.args.p_operation)).toEqual(["start"]);
    expect(h.http).toHaveLength(1);
    const url = new URL(h.http[0]!.url);
    expect(url.origin + url.pathname).toBe("https://app.mailivery.io/api/v1/embed/form/secure");
    expect(url.searchParams.get("tags")).toBe(`lifty-ws:${workspace},lifty-sender:${sender}`);
    const headers = h.http[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(headers["x-request-id"]).toBe("req-1");
    expect(h.http[0]!.init!.method).toBe("GET");
    expect(result).toMatchObject({ state: "link_issued", connect_url: signedUrl, expires_at: new Date(expires * 1000).toISOString() });
  });

  it("never mints a second form while Microsoft consent is pending", async () => {
    for (const reason of ["microsoft_consent_pending", null]) {
      const consent = harness({ data: stored({}, { state: "pending_consent", blocking_reason: reason }) });
      const result = await consent.ops.start(consent.session, "senja");
      expect(result).toMatchObject({ state: "pending_consent", connect_url: null, expires_at: null,
        blocking_reason: { code: "microsoft_consent_pending", message: expect.stringMatching(/Finish the Microsoft consent step in Mailivery/) } });
      expect(consent.http).toHaveLength(0);
    }
    const noKey = harness({ key: null, data: stored({}, { state: "pending_consent" }) });
    expect(await noKey.ops.start(noKey.session, "senja")).toMatchObject({ state: "pending_consent", connect_url: null });
  });

  it("starts a new warmup after removal with a fresh link", async () => {
    let calls = 0;
    const h = harness();
    const session = { userId: user, client: { rpc: async (_name: string, args: Record<string, unknown>) => {
      calls++;
      return { data: args.p_operation === "status"
        ? stored({ evidence: null }, { state: "removed", provider_campaign_bound: true })
        : stored({ evidence: null }, { state: "link_issued", binding_ref: sender, sender_ref: binding, provider_campaign_bound: false, snapshot: null, last_readback_at: null }), error: null };
    } } };
    expect(await h.ops.status(session, "senja")).toMatchObject({ state: "removed", state_label: "Removed" });
    const result = await h.ops.start(session, "senja");
    expect(result).toMatchObject({ state: "link_issued", connect_url: signedUrl });
    expect(new URL(h.http[0]!.url).searchParams.get("tags")).toBe(`lifty-ws:${workspace},lifty-sender:${binding}`);
    expect(calls).toBe(2);
  });

  it("reflects pending actions in the label, with remove winning", () => {
    expect(presentWarmupStatus(stored({}, { requested_action: "pause" }), now).state_label).toBe("Pausing warmup at the next check");
    expect(presentWarmupStatus(stored({}, { state: "paused", requested_action: "resume" }), now).state_label).toBe("Resuming warmup at the next check");
    expect(presentWarmupStatus(stored({}, { state: "paused", requested_action: "remove" }), now).state_label).toBe("Removing warmup at the next check");
    expect(presentWarmupStatus(stored({}, { state: "problem", requested_action: "remove" }), now).state_label).toBe("Removing warmup at the next check");
    expect(presentWarmupStatus(stored({}, { state: "paused", requested_action: null }), now).state_label).toBe("Paused");
    const removing = presentWarmupStatus(stored({}, { requested_action: "remove" }), now);
    expect(removing.recommended_go_live.message).toMatch(/not running right now/);
  });

  it("does not mint a form for a running warmup", async () => {
    const running = harness();
    const result = await running.ops.start(running.session, "senja");
    expect(result).toMatchObject({ state: "warming", connect_url: null, expires_at: null });
    expect(running.http).toHaveLength(0);
  });

  it.each([
    ["PT401", "unauthenticated", 401, /Sign in/],
    ["PT403", "email_workspace_forbidden", 403, /Lifty workspace you belong to/],
    ["PT409", "email_warmup_mailbox_taken", 409, /another Lifty workspace/],
    ["PT409", "email_workspace_suspended", 409, /paused/],
    ["PT409", "email_warmup_not_started", 409, /Start it first/],
    ["PT400", "email_invalid_request", 400, /workspace/],
  ] as const)("maps %s %s to a founder message", async (code, message, status, text) => {
    const h = harness({ error: { code, message } });
    await expect(h.ops.start(h.session, "senja")).rejects.toMatchObject({ status, code: message.toUpperCase(), message: expect.stringMatching(text) });
    expect(h.http).toHaveLength(0);
  });

  it("refuses without a verified email connection", async () => {
    const h = harness({ error: { code: "PT409", message: "email_connection_required" } });
    await expect(h.ops.start(h.session, "senja")).rejects.toMatchObject({ status: 409, code: "EMAIL_CONNECTION_REQUIRED",
      message: expect.stringMatching(/Connect and verify/) });
    expect(h.http).toHaveLength(0);
  });

  it("fails closed without MAILIVERY_API_KEY before writing, but still reports a running warmup", async () => {
    const empty = harness({ key: null, data: stored({ evidence: null }, null) });
    await expect(empty.ops.start(empty.session, "senja")).rejects.toMatchObject({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED" });
    expect(empty.rpcCalls.map(call => call.args.p_operation)).toEqual(["status"]);
    const linkNeeded = harness({ key: null, data: stored({}, { state: "link_issued" }) });
    await expect(linkNeeded.ops.start(linkNeeded.session, "senja")).rejects.toMatchObject({ code: "EMAIL_WARMUP_NOT_CONFIGURED" });
    const running = harness({ key: null });
    expect(await running.ops.start(running.session, "senja")).toMatchObject({ state: "warming", connect_url: null });
    expect([...empty.http, ...linkNeeded.http, ...running.http]).toHaveLength(0);
  });

  it.each([
    ["provider error", () => new Response(JSON.stringify({ message: `bad key ${apiKey}` }), { status: 401 })],
    ["envelope failure", () => new Response(JSON.stringify({ success: false, data: { url: signedUrl } }), { status: 200 })],
    ["foreign host", () => new Response(JSON.stringify({ data: { url: `https://evil.example/form?expires=${expires}` } }), { status: 200 })],
    ["expired url", () => new Response(JSON.stringify({ data: { url: "https://app.mailivery.io/f?expires=1000000000&signature=x" } }), { status: 200 })],
    ["non json", () => new Response("<html>oops</html>", { status: 200 })],
    ["transport", () => { throw new Error(`socket ${apiKey}`); }],
  ] as const)("redacts provider detail on %s", async (_name, provider) => {
    const h = harness({ data: stored({}, { state: "link_issued" }), provider });
    const error = await h.ops.start(h.session, "senja").then(() => { throw new Error("expected failure"); }, (value: unknown) => value as Error & { code: string; status: number });
    expect(error).toMatchObject({ status: 502, code: "EMAIL_WARMUP_LINK_UNAVAILABLE" });
    expect(JSON.stringify({ message: error.message, cause: String(error.cause ?? "") })).not.toMatch(/KEY-secret|SIGNATURE_SECRET|bad key|oops|socket/);
  });

  it.each(["pause", "resume", "remove"] as const)("sends %s to the founder RPC", async operation => {
    const h = harness({ data: stored({}, { requested_action: operation === "resume" ? "resume" : operation }) });
    const result = await h.ops[operation](h.session, "senja");
    expect(h.rpcCalls).toEqual([{ name: "lifty_email_warmup", args: { p_operation: operation, p_payload: { workspace: "senja" } } }]);
    expect(result.requested_action).toBe(operation);
    expect(h.http).toHaveLength(0);
  });

  it("maps unknown database errors and malformed rows to a generic failure", async () => {
    const h = harness({ error: { code: "XX000", message: "relation private.lifty_email_warmup_bindings leaked" } });
    await expect(h.ops.status(h.session, "senja")).rejects.toMatchObject({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE",
      message: expect.not.stringContaining("private") });
    const bad = harness({ data: { ...stored(), binding: { ...stored().binding, state: "exploded" } } });
    await expect(bad.ops.status(bad.session, "senja")).rejects.toMatchObject({ code: "EMAIL_WARMUP_UNAVAILABLE" });
  });

  it("strips extra database keys such as provider campaign IDs", async () => {
    const h = harness({ data: { ...stored(), provider_campaign_id: "987654", binding: { ...stored().binding, provider_campaign_id: "987654" } } });
    expect(JSON.stringify(await h.ops.status(h.session, "senja"))).not.toContain("987654");
  });

  it("validates the signed URL claim itself", () => {
    expect(readSignedFormUrl(signedUrl, now)?.expiresAt).toBe(new Date(expires * 1000).toISOString());
    expect(readSignedFormUrl(`http://app.mailivery.io/x?expires=${expires}`, now)).toBeNull();
    expect(readSignedFormUrl(`https://user:pw@app.mailivery.io/x?expires=${expires}`, now)).toBeNull();
    expect(readSignedFormUrl(`https://app.mailivery.io.evil.test/x?expires=${expires}`, now)).toBeNull();
    expect(readSignedFormUrl("https://app.mailivery.io/x", now)).toBeNull();
    expect(readSignedFormUrl(`https://app.mailivery.io/x?expires=${expires}&expires=${expires}`, now)).toBeNull();
  });
});

describe("warmup routes", () => {
  const session = { userId: user, client: {} };
  const status = presentWarmupStatus(stored(), now);
  const start = { ...status, connect_url: signedUrl, expires_at: new Date(expires * 1000).toISOString() };
  function app(overrides: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const client = createApp({ authenticate: async () => ({ ok: true, session }), log: () => {},
      getEmailWarmup: async (...args) => { calls.push(["status", ...args]); return status; },
      startEmailWarmup: async (...args) => { calls.push(["start", ...args]); return start; },
      changeEmailWarmup: async (...args) => { calls.push(["change", ...args]); return status; },
      ...overrides });
    return { client, calls };
  }
  const post = (client: ReturnType<typeof app>["client"], path: string, body: unknown) => client.request(path, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" }, body: JSON.stringify(body) });

  it("serves status and start with strict contracts", async () => {
    const h = app();
    const read = await h.client.request("/v1/email/warmup?workspace=senja", { headers: { authorization: "Bearer test" } });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual(status);
    const started = await post(h.client, "/v1/email/warmup/start", { workspace: "senja" });
    expect(await started.json()).toEqual(start);
    expect(h.calls).toEqual([["status", session, "senja"], ["start", session, "senja"]]);
  });

  it.each(["pause", "resume", "remove"] as const)("routes %s with the explicit workspace", async operation => {
    const h = app();
    const response = await post(h.client, `/v1/email/warmup/${operation}`, { workspace: "senja" });
    expect(response.status).toBe(200);
    expect(h.calls).toEqual([["change", session, "senja", operation]]);
  });

  it("rejects missing workspaces and extra fields before any upstream call", async () => {
    const h = app();
    expect((await h.client.request("/v1/email/warmup", { headers: { authorization: "Bearer test" } })).status).toBe(400);
    expect((await post(h.client, "/v1/email/warmup/start", { workspace: "senja", tags: ["lifty-ws:other"] })).status).toBe(400);
    expect((await post(h.client, "/v1/email/warmup/pause", {})).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("fails closed when an implementation returns an unexpected field", async () => {
    const h = app({ getEmailWarmup: async () => ({ ...status, provider_campaign_id: "123" }) });
    const response = await h.client.request("/v1/email/warmup?workspace=senja", { headers: { authorization: "Bearer test" } });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("123\"");
  });

  it("reports an unconfigured server as 503", async () => {
    const client = createApp({ authenticate: async () => ({ ok: true, session }), log: () => {} });
    const response = await post(client, "/v1/email/warmup/start", { workspace: "senja" });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("EMAIL_WARMUP_NOT_CONFIGURED");
  });

  it("publishes every warmup route as authenticated OpenAPI", async () => {
    const contract = await (await createApp({ log: () => {} }).request("/openapi.json")).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    for (const [path, method] of [["/v1/email/warmup", "get"], ["/v1/email/warmup/start", "post"], ["/v1/email/warmup/pause", "post"],
      ["/v1/email/warmup/resume", "post"], ["/v1/email/warmup/remove", "post"]] as const) {
      expect(contract.paths[path]?.[method]?.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});
