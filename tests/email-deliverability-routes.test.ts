import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmailDeliverabilityOperations, presentDeliverability } from "../src/email-deliverability.js";
import { DeliverabilitySource, type PlacementDetail, type SourceTest } from "../src/email-deliverability-contracts.js";
import { createApp } from "../src/app.js";
import { createCurrentClient } from "./current-client.js";

const now = new Date("2026-09-29T19:52:59Z");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/email-deliverability/${name}`, import.meta.url), "utf8"));
const memberA = fixture("source-member-a.json");
const fleet = fixture("source-fleet-fixtures.json");
const userA = "10390000-0000-4000-8000-000000000001";
const slOnlyRef = "963de4a2-2f2f-4b0f-3a17-2b9dfb4a38a8";

/** A single-inbox source: what the database returns for mailbox=<ref>. */
function single(email: string, base = memberA): Record<string, unknown> {
  const copy = structuredClone(base) as { mailboxes: { email: string }[]; total_count: number };
  copy.mailboxes = copy.mailboxes.filter(item => item.email === email);
  copy.total_count = copy.mailboxes.length;
  return copy as unknown as Record<string, unknown>;
}

function harness(options: { data?: unknown; error?: unknown; throws?: boolean; details?: (tests: SourceTest[], email: string) => Promise<PlacementDetail[]> } = {}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const detailCalls: { tests: string[]; email: string }[] = [];
  const session = { userId: userA, client: { rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (options.throws) throw new Error("network");
    return options.error ? { data: null, error: options.error } : { data: options.data ?? memberA, error: null };
  } } };
  const ops = createEmailDeliverabilityOperations({ now: () => now,
    readPlacementDetails: async (tests, email) => {
      detailCalls.push({ tests: tests.map(test => test.test_ref), email });
      return options.details ? options.details(tests, email) : tests.map(test => ({ test_ref: test.test_ref, status: "ok" as const, message: "Stored.", providers: [], auth: null, blacklisted: null }));
    } });
  return { ops, session, rpcCalls, detailCalls };
}

describe("deliverability read operation", () => {
  it("reads with the caller's session and only the database filters", async () => {
    const h = harness();
    const response = await h.ops.read(h.session, { workspace: "fixture-a" });
    expect(h.rpcCalls).toEqual([{ name: "deliverability_read", args: { p_query: { workspace: "fixture-a", history_limit: 3, limit: 50 } } }]);
    expect(response).toEqual(presentDeliverability(DeliverabilitySource.parse(memberA), now, { detail: null, details: new Map(), warnings: [] }));
    expect(h.detailCalls).toEqual([]);
    const f = harness({ data: fleet });
    await f.ops.read(f.session, { scope: "fleet", sender: "unassigned", cursor: "abc_-1", history_limit: 8, limit: 10 });
    expect(f.rpcCalls[0]!.args).toEqual({ p_query: { scope: "fleet", sender: "unassigned", cursor: "abc_-1", history_limit: 8, limit: 10 } });
  });

  it.each([
    ["deliverability_workspace_forbidden", 403, "DELIVERABILITY_WORKSPACE_FORBIDDEN"],
    ["deliverability_fleet_forbidden", 403, "DELIVERABILITY_FLEET_FORBIDDEN"],
    ["deliverability_sender_not_found", 404, "DELIVERABILITY_SENDER_NOT_FOUND"],
    ["deliverability_mailbox_not_found", 404, "DELIVERABILITY_MAILBOX_NOT_FOUND"],
    ["deliverability_invalid_request", 400, "DELIVERABILITY_INVALID_REQUEST"],
    ["unauthenticated", 401, "UNAUTHORIZED"],
    ["permission denied for function", 502, "DELIVERABILITY_UNAVAILABLE"],
  ])("fails closed on %s without reading provider reports", async (message, status, code) => {
    const h = harness({ error: { code: "PT403", message } });
    await expect(h.ops.read(h.session, { workspace: "fixture-b", mailbox: slOnlyRef, detail: "placement" })).rejects.toMatchObject({ status, code });
    expect(h.detailCalls).toEqual([]);
  });

  it("rejects invalid, foreign or inconsistent sources", async () => {
    const thrown = harness({ throws: true });
    await expect(thrown.ops.read(thrown.session, { workspace: "fixture-a" })).rejects.toMatchObject({ status: 502 });
    const invalid = harness({ data: { ...memberA, contract: "deliverability-source.v0" } });
    await expect(invalid.ops.read(invalid.session, { workspace: "fixture-a" })).rejects.toMatchObject({ status: 502 });
    // An inbox outside the workspaces the database authorized must never be shown.
    const foreign = structuredClone(memberA) as { mailboxes: { workspace_ref: string }[] };
    foreign.mailboxes[0]!.workspace_ref = "10391000-0000-4000-8000-000000000002";
    const leaked = harness({ data: foreign });
    await expect(leaked.ops.read(leaked.session, { workspace: "fixture-a" })).rejects.toMatchObject({ status: 502 });
    const scope = harness({ data: fleet });
    await expect(scope.ops.read(scope.session, { workspace: "fixture-a" })).rejects.toMatchObject({ status: 502 });
  });

  it("resolves detail only for the authorized inbox's newest completed tests", async () => {
    const h = harness({ data: single("sl-only@a.test") });
    const response = await h.ops.read(h.session, { workspace: "fixture-a", mailbox: slOnlyRef, detail: "placement" });
    expect(h.detailCalls).toEqual([{ tests: ["smartlead:900004", "smartlead:900003", "smartlead:900002"], email: "sl-only@a.test" }]);
    expect(response.query.detail).toBe("placement");
    expect(response.mailboxes[0]!.placement.detail!.map(item => item.test_ref)).toEqual(["smartlead:900004", "smartlead:900003", "smartlead:900002"]);
    const pending = harness({ data: single("uni-only@a.test") });
    await pending.ops.read(pending.session, { workspace: "fixture-a", mailbox: slOnlyRef, detail: "placement" });
    // Pending, running and failed attempts have no report to read.
    expect(pending.detailCalls).toEqual([{ tests: [], email: "uni-only@a.test" }]);
  });

  it("keeps the inbox when a provider report is unavailable", async () => {
    const h = harness({ data: single("sl-only@a.test"), details: async tests => tests.map((test, index) => index === 0
      ? { test_ref: test.test_ref, status: "unavailable" as const, message: "The provider report did not respond in time.", providers: [], auth: null, blacklisted: null }
      : { test_ref: test.test_ref, status: "not_configured" as const, message: "Provider placement reports are not configured on this server.", providers: [], auth: null, blacklisted: null }) });
    const response = await h.ops.read(h.session, { workspace: "fixture-a", mailbox: slOnlyRef, detail: "placement" });
    expect(response.mailboxes[0]!.placement.status.code).toBe("passed");
    expect(response.warnings.map(item => item.code)).toEqual(["placement_detail_unavailable", "placement_detail_not_configured"]);
    const multiple = harness();
    await expect(multiple.ops.read(multiple.session, { workspace: "fixture-a", mailbox: slOnlyRef, detail: "placement" })).rejects.toMatchObject({ status: 502 });
  });

  it("reports Smartlead detail as not configured without a report reader", async () => {
    const session = harness({ data: single("sl-only@a.test") }).session;
    const response = await createEmailDeliverabilityOperations({ now: () => now }).read(session, { workspace: "fixture-a", mailbox: slOnlyRef, detail: "placement" });
    expect(response.mailboxes[0]!.placement.detail!.map(item => item.status)).toEqual(["not_configured", "not_configured", "not_configured"]);
    expect(response.warnings.map(item => item.code)).toEqual(["placement_detail_not_configured"]);
  });
});

describe("deliverability route", () => {
  const response = presentDeliverability(DeliverabilitySource.parse(memberA), now);
  function app(overrides: Record<string, unknown> = {}, authenticated = true) {
    const calls: unknown[][] = [];
    const client = createCurrentClient({
      authenticate: async request => authenticated
        ? { ok: true, session: { userId: request.headers.get("authorization") === "Bearer cli" ? "cli" : "dashboard", client: {} } }
        : { ok: false, reason: "invalid_session" },
      log: () => {},
      getEmailDeliverability: async (...args) => { calls.push(args); return response; },
      ...overrides });
    return { client, calls };
  }
  const get = (client: ReturnType<typeof app>["client"], query: string, token = "dashboard") =>
    client.request(`/v1/email/deliverability${query}`, { headers: { authorization: `Bearer ${token}` } });

  it("serves the same contract to dashboard and CLI sessions", async () => {
    const h = app();
    const web = await get(h.client, "?workspace=fixture-a");
    const cli = await get(h.client, "?workspace=fixture-a", "cli");
    expect(web.status).toBe(200);
    expect(web.headers.get("cache-control")).toBe("no-store");
    expect(await web.json()).toEqual(await cli.json());
    expect(h.calls.map(call => [(call[0] as { userId: string }).userId, call[1]])).toEqual([
      ["dashboard", { workspace: "fixture-a", scope: "workspace", history_limit: 3, limit: 50 }],
      ["cli", { workspace: "fixture-a", scope: "workspace", history_limit: 3, limit: 50 }],
    ]);
  });

  it("rejects invalid filters before any read", async () => {
    const h = app();
    for (const query of ["", "?workspace=fixture-a&history_limit=9", "?workspace=fixture-a&limit=0", "?workspace=fixture-a&workspace=fixture-b",
      "?workspace=fixture-a&is_admin=true", "?workspace=fixture-a&detail=placement", "?workspace=fixture-a&detail=placement&mailbox=a@a.test",
      "?workspace=bad%20slug", "?workspace=fixture-a&sender=nobody", "?workspace=fixture-a&cursor=%2F%2F"]) {
      expect((await get(h.client, query)).status, query).toBe(400);
    }
    expect((await (await get(h.client, "?workspace=fixture-a&detail=placement")).json()).error.message).toBe("Placement detail needs one mailbox_ref.");
    expect(h.calls).toEqual([]);
  });

  it("requires a valid session and fails closed on unexpected fields", async () => {
    const denied = app({}, false);
    expect((await get(denied.client, "?workspace=fixture-a")).status).toBe(401);
    expect(denied.calls).toEqual([]);
    const leaky = app({ getEmailDeliverability: async () => ({ ...response, service_key: "secret" }) });
    const result = await get(leaky.client, "?workspace=fixture-a");
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("secret");
  });

  it("maps authorization errors and an unconfigured server", async () => {
    const ops = createEmailDeliverabilityOperations({ now: () => now });
    const client = createCurrentClient({ log: () => {},
      authenticate: async () => ({ ok: true, session: { userId: userA, client: { rpc: async () => ({ data: null, error: { code: "PT403", message: "deliverability_workspace_forbidden" } }) } } }),
      getEmailDeliverability: ops.read });
    const forbidden = await client.request("/v1/email/deliverability?workspace=fixture-b", { headers: { authorization: "Bearer a" } });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("DELIVERABILITY_WORKSPACE_FORBIDDEN");
    const bare = createApp({ authenticate: async () => ({ ok: true, session: { userId: userA, client: {} } }), log: () => {} });
    const unconfigured = await bare.request("/v1/email/deliverability?workspace=fixture-a",
      { headers: { authorization: "Bearer a", "x-lifty-client-contract": "lifty-cli-context.v7" } });
    expect(unconfigured.status).toBe(503);
  });

  it("documents the route in OpenAPI", async () => {
    const spec = await (await app().client.request("/openapi.json")).json() as { paths: Record<string, Record<string, { operationId: string }>> };
    expect(spec.paths["/v1/email/deliverability"]?.get?.operationId).toBe("getEmailDeliverability");
  });
});
