import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";

// LIF-1477 `get|patch crm rules` and `post crm rules-preview`: the catalog
// routes call the member RPCs with the database-resolved workspace, reject a
// malformed rules object before any call, and never turn an unknown read into
// default rules. Shaped after the get_lifty_crm_rules contract.
const lead = { id: "8d0f5a52-8a43-4c1e-9a55-7a3c0e0c5b11", name: "Ana Ruiz", company: "Acme" };
const preview = {
  meetings: [{ id: "m-1", lead, title: "Intro", booked_at: "2026-10-01T10:00:00.123456+00:00",
    starts_at: "2026-10-03T15:00:00+00:00", status: "completed", credit: "created" }],
  deals: [{ id: "d-1", lead, name: "Acme pilot", stage: "Proposal", status: "open", amount: 12000, currency: "USD",
    created_at: "2026-10-05T09:00:00+00:00", credit: "enriched" }],
};
const receipt = {
  workspace: { workspace_ref: "4b1c2d3e-5f60-4718-8a9b-0c1d2e3f4a5b", name: "Example", state: "ready_for_connections" },
  provider: "hubspot", connected: true, version: 0, updated_at: null, updated_by: null,
  rules: {
    meetings: { skip_customers: true, title_excludes: [], excluded_types: [], excluded_sources: [], outcomes: {} },
    deals: { title_excludes: [], excluded_pipelines: [] },
  },
  catalog: { meeting_types: [{ value: "Discovery", label: "Discovery" }], meeting_sources: [], meeting_outcomes: [], pipelines: [] },
  preview,
};
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), log: () => {} });
  const headers = { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" };
  const send = (method: string, route: string, body: unknown) => app.request(route, {
    method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    read: () => app.request("/v1/workspace/crm/rules", { headers }),
    preview: (body: unknown) => send("POST", "/v1/workspace/crm/rules/preview", body),
    patch: (body: unknown) => send("PATCH", "/v1/workspace/crm/rules", body),
    calls,
  };
}
const dbError = (code: string, message: string, details: unknown = null) =>
  Object.assign(new Error(message), { code, message, details: details === null ? null : JSON.stringify(details) });

describe("CRM counting rules routes", () => {
  it("reads, previews and saves the selected CRM's rules through the documented RPCs", async () => {
    const meetings = { skip_customers: false, title_excludes: ["internal"], excluded_types: [null], outcomes: { RESCHEDULED: "excluded" } };
    const saved = { ...receipt, version: 1, updated_at: "2026-10-14T12:00:00+00:00", updated_by: "founder@example.com",
      rules: { ...receipt.rules, meetings: { ...receipt.rules.meetings, ...meetings } } };
    const previewed = { workspace: receipt.workspace, preview: { ...preview, meetings: [] } };
    const h = harness(name => name === "get_lifty_crm_rules" ? receipt : name === "preview_lifty_crm_rules" ? previewed : saved);
    const read = await h.read();
    expect([read.status, read.headers.get("cache-control"), await read.json()]).toEqual([200, "no-store", receipt]);
    const shown = await h.preview({ meetings });
    expect([shown.status, await shown.json()]).toEqual([200, previewed]);
    const body = { expected_version: 0, meetings };
    const changed = await h.patch(body);
    expect([changed.status, await changed.json()]).toEqual([200, saved]);
    expect(h.calls).toEqual([
      { name: "get_lifty_crm_rules", args: { p_workspace_id: null } },
      { name: "preview_lifty_crm_rules", args: { p_workspace_id: null, p_payload: { meetings } } },
      { name: "patch_lifty_crm_rules", args: { p_workspace_id: null, p_payload: body } },
    ]);
  });

  it.each<[string, unknown]>([
    ["an unknown kind", { expected_version: 0, contacts: {} }],
    ["an unknown meetings rule", { expected_version: 0, meetings: { owner: "me" } }],
    ["an unknown outcome meaning", { expected_version: 0, meetings: { outcomes: { COMPLETED: "won" } } }],
    ["a wrong rule type", { expected_version: 0, deals: { title_excludes: "internal" } }],
    ["no expected_version", { deals: { excluded_pipelines: ["default"] } }],
  ])("rejects %s with repair issues before any call", async (_case, body) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.patch(body);
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("CRM_RULES_INVALID");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
  });

  it.each<[string, ReturnType<typeof dbError>, number, Record<string, unknown>]>([
    ["a stale version", dbError("PT409", "VERSION_CONFLICT", { current_version: 2 }), 409, { code: "VERSION_CONFLICT", current_version: 2 }],
    ["a member of another workspace", dbError("PT403", "lifty_workspace_forbidden"), 403, { code: "WORKSPACE_FORBIDDEN" }],
    ["an expired session", dbError("PT401", "UNAUTHENTICATED"), 401, { code: "UNAUTHORIZED" }],
    ["a workspace without a CRM", dbError("PT422", "CRM_NOT_SELECTED", { issues: [{ code: "invalid_value", path: "provider",
      message: "Connect a CRM first.", suggestion: "Read the current resource." }] }), 422, { code: "CRM_NOT_SELECTED" }],
    ["a rule the database rejects", dbError("PT422", "CRM_RULES_INVALID", { issues: [{ code: "invalid_value",
      path: "meetings.max_attendees", message: "Attio only.", suggestion: "Read the current resource." }] }),
    422, { code: "CRM_RULES_INVALID", issues: [expect.objectContaining({ path: "meetings.max_attendees" })] }],
  ])("returns the typed database error for %s", async (_case, failure, status, error) => {
    const h = harness(() => { throw failure; });
    const response = await h.patch({ expected_version: 1, meetings: { max_attendees: 10 } });
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject(error);
  });

  it.each<[string, Rpc]>([
    ["a database failure", () => { throw dbError("XX000", "private database detail"); }],
    ["a missing receipt", () => null],
    ["a meaning outside the contract", () => ({ ...receipt, rules: { ...receipt.rules, deals: { stages: { Won: "maybe" } } } })],
  ])("reports %s as unavailable, never as default rules", async (_case, rpc) => {
    const response = await harness(rpc).read();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("CRM_RULES_UNAVAILABLE");
    expect(text).not.toContain("private database detail");
  });

  it("is reachable as `lifty get|patch crm rules`, `lifty post crm rules-preview` and three MCP tools", () => {
    const { operations } = getAgentContext("crm")!;
    const commands = Object.entries(operations!).filter(([, operation]) => operation.cli?.operation.startsWith("rules"))
      .map(([key, operation]) => [key, operation.method, operation.route]);
    expect(commands).toEqual([
      ["rules_get", "GET", "/v1/workspace/crm/rules"],
      ["rules_preview", "POST", "/v1/workspace/crm/rules/preview"],
      ["rules_patch", "PATCH", "/v1/workspace/crm/rules"],
    ]);
    const tools = Object.fromEntries(getStageMcpTools().map(tool => [tool.name, tool]));
    expect(tools.crm_rules_get?.annotations.readOnlyHint).toBe(true);
    expect(tools.crm_rules_preview?.annotations.readOnlyHint).toBe(true);
    expect(tools.crm_rules_patch?.description).toContain("Writes commit synchronously");
  });
});
