import { describe, expect, it, vi } from "vitest";
import { createEmailWarmupOperations, presentWarmupStatus, type EmailWarmupSettings } from "../src/email-warmup.js";
import { WarmupStartResult, WarmupStatus, type StoredWarmupStatus } from "../src/email-warmup-contracts.js";
import { createCurrentClient as createApp } from "./current-client.js";
import { checkWarmupDns, WARMUP_DNS_TIMEOUT_MS, type WarmupDnsResolver } from "../src/warmup-dns.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const binding = "33333333-3333-4333-8333-333333333333";
const sender = "44444444-4444-4444-8444-444444444444";
const user = "11111111-1111-4111-8111-111111111111";
const connection = "55555555-5555-4555-8555-555555555555";
const otherConnection = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-09-22T15:00:00Z");
const setupUrl = `https://api.lifty.test/warmup/setup?intent=${"a".repeat(43)}`;
const snapshot = { status_code: "active", grade: "A", spf: "valid", dmarc: "valid", mx: "valid", domain_age: 400,
  warmup_duration_days: 12, emails_sent_today: 9, outreach_today: 6, response_today: 3, email_per_day_target: 15, connection_problem: false };

function stored(overrides: Partial<StoredWarmupStatus> = {}, bindingOverrides: Record<string, unknown> | null = {}): StoredWarmupStatus {
  return {
    workspace_ref: workspace, connection_ref: connection, email: "founder@example.test", mailbox_use: "outreach", warmup_required: true, required_active_days: 21,
    binding: bindingOverrides === null ? null : { binding_ref: binding, sender_ref: sender, state: "warming", requested_action: null, blocking_reason: null,
      user_paused: false, connection_paused: false, provider_campaign_bound: true, last_readback_at: "2026-09-22T14:00:00Z", snapshot, created_at: "2026-09-10T10:00:00Z", ...bindingOverrides } as StoredWarmupStatus["binding"],
    evidence: { active_duration_days: 12, healthy: true, passed: false, observed_at: "2026-09-22T14:00:00Z", fresh: true },
    warmup_complete: false, warmup_spam: null, warmup_blocker: "email_warmup_required", warmup_ready: false,
    ...overrides,
  };
}
const complete = { warmup_complete: true, warmup_blocker: null, warmup_ready: true,
  evidence: { active_duration_days: 25, healthy: true, passed: true, observed_at: "2026-09-22T14:00:00Z", fresh: true } } as const;

type DnsAnswer = readonly string[] | "NXDOMAIN" | "SERVFAIL" | "HANG";
/** node:dns-shaped fake: every domain publishes SPF, DMARC (p=none) and MX unless a test overrides `txt:<host>` or `mx:<host>`. */
function fakeDns(answers: Record<string, DnsAnswer> = {}): WarmupDnsResolver {
  const answer = async (key: string): Promise<string[]> => {
    const value = answers[key] ?? (key.startsWith("txt:_dmarc.") ? ["v=DMARC1; p=none;"]
      : key.startsWith("txt:") ? ["v=spf1 include:_spf.google.com ~all"] : ["smtp.google.com"]);
    if (value === "HANG") return new Promise<never>(() => {});
    if (value === "NXDOMAIN" || value === "SERVFAIL") throw Object.assign(new Error(key), { code: value === "NXDOMAIN" ? "ENOTFOUND" : "ESERVFAIL" });
    return [...value];
  };
  return { resolveTxt: async host => (await answer(`txt:${host}`)).map(value => [value]),
    resolveMx: async host => (await answer(`mx:${host}`)).map(exchange => ({ exchange, priority: 1 })) };
}

function harness(options: { data?: unknown; error?: unknown; issueSetupLink?: EmailWarmupSettings["issueSetupLink"] | null; dns?: WarmupDnsResolver } = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const links: Array<string | undefined> = [];
  const session = { userId: user, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return options.error ? { data: null, error: options.error } : { data: options.data ?? stored(), error: null };
  } } };
  const issueSetupLink = options.issueSetupLink === null ? undefined : options.issueSetupLink
    ?? (async (_session, _workspace, connectionRef) => { links.push(connectionRef); return { url: setupUrl, expiresAt: now.toISOString() }; });
  const ops = createEmailWarmupOperations({ ...(issueSetupLink ? { issueSetupLink } : {}), now: () => now, dns: options.dns ?? fakeDns() });
  return { ops, session, rpcCalls, links };
}

describe("warmup status presentation", () => {
  it("maps a dedicated mailbox in warmup to days, volume, checks and a projected completion", () => {
    const status = presentWarmupStatus(stored(), now);
    expect(WarmupStatus.parse(status)).toEqual(status);
    expect(status).toMatchObject({ connection_ref: connection, state: "warming", state_label: "Warming up", active_days: 12, required_active_days: 21,
      warmup_required: true, initial_period_complete: false, warmup_ready: false, spam: null, today: { warmup_emails: 9, ramp_target: 15 },
      checks: { spf: "valid", dmarc: "valid", mx: "valid" }, last_checked_at: "2026-09-22T14:00:00Z", blocking_reason: null });
    expect(status.recommended_go_live).toMatchObject({ kind: "projected", date: "2026-10-01", remaining_active_days: 9 });
    expect(status.recommended_go_live.message).toContain("Paused days");
    expect(status.recommended_go_live.message).toContain("2026-10-01");
  });

  it("never names the warmup provider in the customer response", () => {
    for (const value of [stored(), stored({}, { state: "link_issued", provider_campaign_bound: false }), stored({}, { state: "problem", blocking_reason: "connection_problem" })]) {
      const status = presentWarmupStatus(value, now);
      expect(status).not.toHaveProperty("provider");
      expect(JSON.stringify(status)).not.toMatch(/mailivery/i);
    }
  });

  it("tells a habitual mailbox to proceed to placement while preserving the spam guard", () => {
    const status = presentWarmupStatus(stored({ mailbox_use: "personal", warmup_required: false, warmup_blocker: null, warmup_ready: true }), now);
    expect(status).toMatchObject({ warmup_required: false, warmup_ready: true,
      recommended_go_live: { kind: "now", date: "2026-09-22", remaining_active_days: null } });
    expect(status.recommended_go_live.message).toMatch(/No initial warmup period is required/);
  });

  it("reports a completed initial period only from the database predicate, even when the latest check is stale", () => {
    const done = presentWarmupStatus(stored({ ...complete, evidence: { ...complete.evidence, fresh: false } }), now);
    expect(done).toMatchObject({ initial_period_complete: true, warmup_ready: true,
      recommended_go_live: { kind: "unlocked", date: "2026-09-22", remaining_active_days: 0 } });
    expect(done.recommended_go_live.message).toMatch(/measured spam can hold sending independently/);
    // Enough days but no completing healthy check: no date is promised.
    const waiting = presentWarmupStatus(stored({ evidence: { active_duration_days: 22, healthy: false, passed: false, observed_at: "2026-09-20T14:00:00Z", fresh: false } }), now);
    expect(waiting.recommended_go_live).toMatchObject({ kind: "awaiting_check", date: null, remaining_active_days: 0 });
  });

  it("explains a spam hold with the measured counts and never calls it ready", () => {
    const spam = { spam_count: 3, sent: 20, window_days: 7, blocking: true, warning: true, observed_at: "2026-09-22T14:00:00Z" };
    const held = presentWarmupStatus(stored({ ...complete, warmup_spam: spam, warmup_blocker: "email_warmup_spam", warmup_ready: false }, { state: "paused", user_paused: true, connection_paused: true, blocking_reason: "dns_invalid" }), now);
    expect(held).toMatchObject({ warmup_ready: false, initial_period_complete: true,
      user_paused: true, connection_paused: true, blocking_reason: { code: "dns_invalid" },
      spam: { spam_count: 3, sent: 20, window_days: 7, holds_sending: true, warning: true },
      recommended_go_live: { kind: "held", date: null } });
    expect(held.recommended_go_live.message).toMatch(/^3 of 20 warmup emails landed in spam over the last 7 days\. Lifty holds/);
    // A warning below the limit is reported without holding.
    const warned = presentWarmupStatus(stored({ ...complete, warmup_spam: { ...spam, spam_count: 1, blocking: false } }), now);
    expect(warned).toMatchObject({ warmup_ready: true, spam: { holds_sending: false, warning: true }, recommended_go_live: { kind: "unlocked" } });
  });

  it("never projects earlier than the evidence allows when no evidence exists", () => {
    const status = presentWarmupStatus(stored({ evidence: null }, { state: "link_issued", provider_campaign_bound: false, snapshot: null, last_readback_at: null }), now);
    expect(status).toMatchObject({ state: "link_issued", state_label: "Waiting for you to authorize the mailbox with Google", active_days: 0,
      today: { warmup_emails: null, ramp_target: null }, checks: { spf: "unknown", dmarc: "unknown", mx: "unknown" }, last_checked_at: null });
    expect(status.recommended_go_live).toMatchObject({ kind: "projected", date: "2026-10-13", remaining_active_days: 21 });
    expect(status.recommended_go_live.message).toMatch(/not running right now/);
  });

  it.each([
    ["paused", null, "Paused"],
    ["paused", "account_disconnected", "Paused"],
    ["problem", "dns_invalid", "Needs attention"],
    ["pending_consent", "microsoft_consent_pending", "Waiting for Microsoft consent"],
    ["removed", null, "Removed"],
  ] as const)("describes %s (%s) in plain words and moves the date while not running", (state, reason, label) => {
    const status = presentWarmupStatus(stored({}, { state, blocking_reason: reason, snapshot: { ...snapshot, spf: "invalid", mx: null } }), now);
    expect(status.state_label).toBe(label);
    expect(status.checks).toEqual({ spf: "not_valid", dmarc: "valid", mx: "unknown" });
    if (reason) expect(status.blocking_reason).toMatchObject({ code: reason, message: expect.not.stringContaining("_") });
    expect(status.recommended_go_live.message).toMatch(/not running right now/);
  });

  it("covers a workspace without an email account and never exposes unknown database keys", () => {
    const status = presentWarmupStatus(stored({ connection_ref: null, email: null, mailbox_use: null, warmup_required: false, evidence: null,
      warmup_blocker: null, warmup_ready: false }, null), now);
    expect(status).toMatchObject({ connection_ref: null, state: "not_started", state_label: "Not started", requested_action: null,
      warmup_ready: false, recommended_go_live: { kind: "connect_email", date: null } });
    expect(Object.keys(status)).not.toContain("binding");
    expect(JSON.stringify(status)).not.toContain(sender);
  });

  it("names the records a pre-start DNS hold is waiting for", () => {
    const dmarc = presentWarmupStatus(stored({}, { state: "pending_consent", blocking_reason: "dns_invalid_dmarc",
      last_readback_at: null, snapshot: null }), now);
    expect(dmarc.state_label).toBe("Waiting for valid DNS records");
    expect(dmarc.blocking_reason).toEqual({ code: "dns_invalid_dmarc",
      message: expect.stringMatching(/no valid DMARC record\. .*_dmarc.*starts warmup on its own/) });
    // WarmupStatus caps the message at 300 characters; the longest variant must fit.
    const all = presentWarmupStatus(stored({}, { state: "pending_consent", blocking_reason: "dns_invalid_spf_dmarc_mx", snapshot: null }), now);
    expect(all.blocking_reason!.message).toMatch(/no valid SPF, DMARC and MX records\. Add them/);
  });

  it("gives unknown blocking reasons a generic sentence", () => {
    const status = presentWarmupStatus(stored({}, { state: "problem", blocking_reason: "provider_quirk" }), now);
    expect(status.blocking_reason).toEqual({ code: "provider_quirk", message: expect.stringContaining("can't describe") });
  });
});

describe("warmup operations", () => {
  it("reads status with only the workspace; the database resolves its single account", async () => {
    const h = harness();
    expect(await h.ops.status(h.session, "senja")).toMatchObject({ connection_ref: connection });
    expect(h.rpcCalls).toEqual([{ name: "lifty_email_warmup", args: { p_operation: "status", p_payload: { workspace: "senja" } } }]);
  });

  it("issues the Lifty Google setup link for the resolved account of a link_issued binding", async () => {
    const h = harness({ data: stored({ evidence: null }, { state: "link_issued", provider_campaign_bound: false, snapshot: null, last_readback_at: null }) });
    const result = await h.ops.start(h.session, "senja");
    expect(WarmupStartResult.parse(result)).toEqual(result);
    expect(h.rpcCalls.map(call => call.args.p_operation)).toEqual(["status", "start"]);
    expect(h.links).toEqual([connection]);
    expect(result).toMatchObject({ state: "link_issued", connect_url: setupUrl, expires_at: now.toISOString() });
  });

  it("issues no link and writes nothing while the mailbox domain verifiably lacks DMARC; valid or unverifiable DNS gets the link", async () => {
    const unbound = stored({ evidence: null }, { state: "link_issued", provider_campaign_bound: false, snapshot: null, last_readback_at: null });
    const missing = harness({ data: unbound, dns: fakeDns({ "txt:_dmarc.example.test": "NXDOMAIN" }) });
    await expect(missing.ops.start(missing.session, "senja")).rejects.toMatchObject({ status: 409, code: "EMAIL_WARMUP_DNS_INVALID",
      message: expect.stringMatching(/^Lifty didn't create a warmup link: example\.test has no valid DMARC record\. .*_dmarc.*Run warmup start again once DNS is published\./) });
    expect(missing.rpcCalls.map(call => call.args.p_operation)).toEqual(["status"]);
    expect(missing.links).toHaveLength(0);
    const all = harness({ data: unbound, dns: fakeDns({ "txt:example.test": "NXDOMAIN", "txt:_dmarc.example.test": [], "mx:example.test": [] }) });
    await expect(all.ops.start(all.session, "senja")).rejects.toMatchObject({ message: expect.stringMatching(/no valid SPF, DMARC and MX records\. Add them/) });
    // SERVFAIL and an unanswered lookup are unknown, not invalid: the link is issued as today.
    for (const answer of ["SERVFAIL", "HANG"] as const) {
      vi.useFakeTimers();
      try {
        const unknown = harness({ data: unbound, dns: fakeDns({ "txt:_dmarc.example.test": answer }) });
        const pending = unknown.ops.start(unknown.session, "senja");
        await vi.advanceTimersByTimeAsync(WARMUP_DNS_TIMEOUT_MS);
        expect(await pending).toMatchObject({ connect_url: setupUrl });
        expect(unknown.rpcCalls.map(call => call.args.p_operation)).toEqual(["status", "start"]);
      } finally { vi.useRealTimers(); }
    }
    const valid = harness({ data: unbound });
    expect(await valid.ops.start(valid.session, "senja")).toMatchObject({ connect_url: setupUrl });
    // A bound warmup issues no link, so its DNS is not consulted.
    const bound = harness({ data: stored(), dns: fakeDns({ "txt:_dmarc.example.test": "NXDOMAIN" }) });
    expect(await bound.ops.start(bound.session, "senja")).toMatchObject({ state: "warming", connect_url: null });
  });

  it.each([
    ["DMARC p=none and SPF ?all are published", {}, []],
    ["two SPF records are a permerror", { "txt:example.test": ["v=spf1 -all", "v=spf1 include:x ~all"] }, ["spf"]],
    ["a _dmarc TXT without v=DMARC1", { "txt:_dmarc.example.test": ["p=reject"] }, ["dmarc"]],
    ["no MX hosts", { "mx:example.test": [] }, ["mx"]],
  ] as const)("classifies DNS like the Jobs check: %s", async (_name, answers, invalid) => {
    const dns = fakeDns({ "txt:example.test": ["v=spf1 include:_spf.google.com ?all"], ...answers });
    expect(await checkWarmupDns("example.test", { resolver: dns })).toEqual({ invalid, unknown: [] });
  });

  it("never issues a second link while Microsoft consent is pending", async () => {
    for (const reason of ["microsoft_consent_pending", null]) {
      const consent = harness({ data: stored({}, { state: "pending_consent", blocking_reason: reason }) });
      const result = await consent.ops.start(consent.session, "senja");
      expect(result).toMatchObject({ state: "pending_consent", connect_url: null, expires_at: null,
        blocking_reason: { code: "microsoft_consent_pending", message: expect.stringMatching(/Finish the Microsoft consent step/) } });
      expect(consent.links).toHaveLength(0);
    }
    const unconfigured = harness({ issueSetupLink: null, data: stored({}, { state: "pending_consent" }) });
    expect(await unconfigured.ops.start(unconfigured.session, "senja")).toMatchObject({ state: "pending_consent", connect_url: null });
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
    expect(result).toMatchObject({ state: "link_issued", connect_url: setupUrl });
    expect(calls).toBe(3);
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

  it("issues no link for a running warmup", async () => {
    const running = harness();
    const result = await running.ops.start(running.session, "senja");
    expect(result).toMatchObject({ state: "warming", connect_url: null, expires_at: null });
    expect(running.links).toHaveLength(0);
  });

  it.each([
    ["PT401", "unauthenticated", 401, /Sign in/],
    ["PT403", "email_workspace_forbidden", 403, /Choose a workspace you belong to/],
    ["PT409", "email_warmup_mailbox_taken", 409, /another Lifty workspace/],
    ["PT409", "email_workspace_suspended", 409, /paused/],
    ["PT409", "email_warmup_not_started", 409, /Start it first/],
    ["PT400", "email_invalid_request", 400, /workspace/],
    ["PT409", "email_mailbox_selection_required", 409, /several email accounts.*connection_ref/],
  ] as const)("maps %s %s to a founder message", async (code, message, status, text) => {
    const h = harness({ error: { code, message } });
    await expect(h.ops.start(h.session, "senja")).rejects.toMatchObject({ status, code: message.toUpperCase(), message: expect.stringMatching(text) });
    expect(h.links).toHaveLength(0);
  });

  it("refuses without a verified email connection", async () => {
    const h = harness({ error: { code: "PT409", message: "email_connection_required" } });
    await expect(h.ops.start(h.session, "senja")).rejects.toMatchObject({ status: 409, code: "EMAIL_CONNECTION_REQUIRED",
      message: expect.stringMatching(/Connect and verify/) });
    expect(h.links).toHaveLength(0);
  });

  it("fails closed without Google setup before writing, but still reports a running warmup", async () => {
    const empty = harness({ issueSetupLink: null, data: stored({ evidence: null }, null) });
    await expect(empty.ops.start(empty.session, "senja")).rejects.toMatchObject({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED" });
    expect(empty.rpcCalls.map(call => call.args.p_operation)).toEqual(["status"]);
    const linkNeeded = harness({ issueSetupLink: null, data: stored({}, { state: "link_issued" }) });
    await expect(linkNeeded.ops.start(linkNeeded.session, "senja")).rejects.toMatchObject({ code: "EMAIL_WARMUP_NOT_CONFIGURED" });
    expect(linkNeeded.rpcCalls.map(call => call.args.p_operation)).toEqual(["status"]);
    const running = harness({ issueSetupLink: null });
    expect(await running.ops.start(running.session, "senja")).toMatchObject({ state: "warming", connect_url: null });
  });

  it.each(["pause", "resume", "remove"] as const)("sends %s to the founder RPC", async operation => {
    const h = harness({ data: stored({}, { requested_action: operation === "resume" ? "resume" : operation }) });
    const result = await h.ops[operation](h.session, "senja");
    expect(h.rpcCalls).toEqual([{ name: "lifty_email_warmup", args: { p_operation: operation, p_payload: { workspace: "senja" } } }]);
    expect(result.requested_action).toBe(operation);
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

  it.each(["status", "pause", "resume", "remove"] as const)("targets only the selected connection for %s", async operation => {
    const h = harness({ data: stored({}, { requested_action: operation === "status" ? null : operation }) });
    const result = await h.ops[operation](h.session, "lift", connection);
    expect(h.rpcCalls).toEqual([{ name: "lifty_email_warmup", args: { p_operation: operation,
      p_payload: { workspace: "lift", connection_ref: connection } } }]);
    expect(result).toMatchObject({ connection_ref: connection });
    expect(result).not.toHaveProperty("campaign_send_paused");
  });

  it("issues separate branded setup links for two connections in the same workspace", async () => {
    const selected: string[] = [];
    for (const connectionRef of [connection, otherConnection]) {
      const h = harness({ data: stored({ connection_ref: connectionRef }, { state: "link_issued" }),
        issueSetupLink: async (session, workspace, ref) => {
          expect(session).toBe(h.session); expect(workspace).toBe("lift"); selected.push(ref!);
          return {url:`https://api.lifty.test/warmup/setup?intent=${ref}`, expiresAt:now.toISOString()};
        } });
      const result = await h.ops.start(h.session, "lift", connectionRef);
      expect(result).toMatchObject({ connection_ref: connectionRef, connect_url: expect.stringContaining(connectionRef) });
      // A read-only status precedes the single start write (DNS is checked in between).
      expect(h.rpcCalls).toEqual(["status", "start"].map(operation => ({ name: "lifty_email_warmup", args: { p_operation: operation,
        p_payload: { workspace: "lift", connection_ref: connectionRef } } })));
    }
    expect(selected).toEqual([connection, otherConnection]);
  });

  it("fails closed on a status for another or a malformed account", async () => {
    for (const data of [stored({ connection_ref: otherConnection }), { ...stored(), warmup_blocker: "something_else" }, { ...stored(), warmup_ready: undefined }]) {
      const h = harness({ data });
      await expect(h.ops.status(h.session, "lift", connection)).rejects.toMatchObject({ code: "EMAIL_WARMUP_UNAVAILABLE" });
    }
  });

  it.each(["status", "start", "pause", "resume", "remove"] as const)("rejects malformed client connection UUID before %s", async operation => {
    const h = harness();
    await expect(h.ops[operation](h.session, "lift", "not-a-uuid")).rejects.toThrow();
    expect(h.rpcCalls).toHaveLength(0); expect(h.links).toHaveLength(0);
  });
});

describe("warmup routes", () => {
  const session = { userId: user, client: {} };
  const status = presentWarmupStatus(stored(), now);
  const start = { ...status, connect_url: setupUrl, expires_at: now.toISOString() };
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

  it("passes explicit connection selection through every authenticated route", async () => {
    const h = app();
    const read = await h.client.request(`/v1/email/warmup?workspace=lift&connection_ref=${connection}`, {headers:{authorization:"Bearer test"}});
    expect(read.status).toBe(200);
    for (const operation of ["start", "pause", "resume", "remove"] as const) {
      expect((await post(h.client, `/v1/email/warmup/${operation}`, {workspace:"lift",connection_ref:connection})).status).toBe(200);
    }
    expect(h.calls).toEqual([["status",session,"lift",connection],["start",session,"lift",connection],
      ["change",session,"lift","pause",connection],["change",session,"lift","resume",connection],["change",session,"lift","remove",connection]]);
  });

  it("rejects malformed connection selection on query and body without an upstream call", async () => {
    const h=app();
    expect((await h.client.request("/v1/email/warmup?workspace=lift&connection_ref=other",{headers:{authorization:"Bearer test"}})).status).toBe(400);
    for (const operation of ["start", "pause", "resume", "remove"]) {
      expect((await post(h.client, `/v1/email/warmup/${operation}`, {workspace:"lift",connection_ref:null})).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("publishes every warmup route as authenticated OpenAPI", async () => {
    const contract = await (await createApp({ log: () => {} }).request("/openapi.json")).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    for (const [path, method] of [["/v1/email/warmup", "get"], ["/v1/email/warmup/start", "post"], ["/v1/email/warmup/pause", "post"],
      ["/v1/email/warmup/resume", "post"], ["/v1/email/warmup/remove", "post"]] as const) {
      expect(contract.paths[path]?.[method]?.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});
