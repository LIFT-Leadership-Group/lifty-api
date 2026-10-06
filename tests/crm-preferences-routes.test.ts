import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";
// Captured from public.get_lifty_crm_preferences in the real local SQL suite
// (lift-supabase-functions scripts/test-lif1239-crm-preferences.py).
import receipt from "./crm-preferences-sql-fixture.json" with { type: "json" };

// LIF-1239 `get|patch crm preferences`: the catalog routes call the member RPCs
// with the database-resolved workspace, reject an invalid choice before any
// write, and never turn an unknown read into a default policy.
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), log: () => {} });
  const headers = { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" };
  const read = () => app.request("/v1/workspace/crm/preferences", { headers });
  const patch = (body: unknown) => app.request("/v1/workspace/crm/preferences", {
    method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { read, patch, calls };
}
const dbError = (code: string, message: string, details: unknown = null) =>
  Object.assign(new Error(message), { code, message, details: details === null ? null : JSON.stringify(details) });

describe("CRM preferences routes", () => {
  it("reads and changes the selected workspace's choices through the documented RPCs", async () => {
    const saved = { ...receipt, version: 7, conversation: { mode: "on_reply", channels: ["email"] } };
    const h = harness(name => name === "get_lifty_crm_preferences" ? receipt : saved);
    const read = await h.read();
    expect([read.status, read.headers.get("cache-control"), await read.json()]).toEqual([200, "no-store", receipt]);
    const body = { expected_version: 6, conversation: { mode: "on_reply" } };
    const changed = await h.patch(body);
    expect([changed.status, await changed.json()]).toEqual([200, saved]);
    expect(h.calls).toEqual([
      { name: "get_lifty_crm_preferences", args: { p_workspace_id: null } },
      { name: "patch_lifty_crm_preferences", args: { p_workspace_id: null, p_payload: body } },
    ]);
  });

  it.each<[string, unknown]>([
    ["an unknown research mode", { expected_version: 1, research: { mode: "all" } }],
    ["an unknown conversation mode", { expected_version: 1, conversation: { mode: "live" } }],
    ["empty channels with an active mode", { expected_version: 1, conversation: { mode: "all", channels: [] } }],
    ["a repeated channel", { expected_version: 1, conversation: { mode: "on_reply", channels: ["email", "email"] } }],
    ["channels with conversations off", { expected_version: 1, conversation: { mode: "none", channels: ["email"] } }],
    ["the stored v1 notes wrapper", { expected_version: 1, notes: { research: { mode: "none" } } }],
    ["no choice", { expected_version: 1 }],
    ["an empty conversation", { expected_version: 1, conversation: {} }],
    ["no expected_version", { research: { mode: "none" } }],
  ])("rejects %s with repair issues before any write", async (_case, body) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.patch(body);
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("CRM_PREFERENCES_INVALID");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
  });

  it.each<[string, ReturnType<typeof dbError>, number, Record<string, unknown>]>([
    ["a stale version", dbError("PT409", "VERSION_CONFLICT", { current_version: 8 }), 409, { code: "VERSION_CONFLICT", current_version: 8 }],
    ["a member of another workspace", dbError("PT403", "lifty_workspace_forbidden"), 403, { code: "WORKSPACE_FORBIDDEN" }],
    ["a workspace without a CRM", dbError("PT409", "CRM_NOT_SELECTED"), 409, { code: "CRM_NOT_SELECTED" }],
    ["a suspended workspace", dbError("PT409", "WORKSPACE_SUSPENDED"), 409, { code: "WORKSPACE_SUSPENDED" }],
    ["channels required by the saved choice", dbError("PT422", "CRM_PREFERENCES_INVALID", { issues: [{ code: "invalid_value",
      path: "/conversation/channels", message: "Choose email, linkedin or both, each once.", suggestion: "Read the current resource." }] }),
    422, { code: "CRM_PREFERENCES_INVALID", issues: [expect.objectContaining({ path: "/conversation/channels" })] }],
  ])("returns the typed database error for %s", async (_case, failure, status, error) => {
    const h = harness(() => { throw failure; });
    const response = await h.patch({ expected_version: 7, conversation: { mode: "all" } });
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject(error);
  });

  it.each<[string, Rpc]>([
    ["an unreadable saved policy", () => { throw dbError("P0001", "CRM_PREFERENCES_UNAVAILABLE"); }],
    ["a database failure", () => { throw dbError("XX000", "private database detail"); }],
    ["a missing receipt", () => null],
    ["a policy outside the v1 choices", () => ({ ...receipt, conversation: { mode: "live", channels: ["email"] } })],
    ["Attio campaign-send wiring", () => ({ ...receipt, outreach_history: { mode: "attio_campaign_sends" } })],
  ])("reports %s as unavailable, never as a default", async (_case, rpc) => {
    const response = await harness(rpc).read();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("CRM_PREFERENCES_UNAVAILABLE");
    expect(text).not.toContain("private database detail");
  });

  it("is reachable as `lifty get|patch crm preferences` and two MCP tools", () => {
    const { operations } = getAgentContext("crm")!;
    const commands = Object.entries(operations!).filter(([, operation]) => operation.cli?.operation === "preferences")
      .map(([key, operation]) => [key, operation.method, operation.route]);
    expect(commands).toEqual([
      ["preferences_get", "GET", "/v1/workspace/crm/preferences"],
      ["preferences_patch", "PATCH", "/v1/workspace/crm/preferences"],
    ]);
    const tools = Object.fromEntries(getStageMcpTools().map(tool => [tool.name, tool]));
    expect(tools.crm_preferences_get?.annotations.readOnlyHint).toBe(true);
    expect(tools.crm_preferences_patch?.description).toContain("Writes commit synchronously");
  });
});
