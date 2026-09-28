import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { callStageMcpTool, getStageMcpTools } from "../src/mcp-stage-tools.js";
import { stageOperations } from "../src/stage-contracts.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";

const incoming = () => new Request("https://api.example.test/mcp", { headers: { authorization: "Bearer founder" } });
const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" };

describe("generated MCP stage operations", () => {
  it("covers every supported operation with unique annotated tools and the canonical schema", () => {
    const tools = getStageMcpTools();
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    for (const [stage, operations] of Object.entries(stageOperations)) for (const [action, operation] of Object.entries(operations)) {
      const name = stage === "summary" && action === "next_step" ? "next_step" : `${stage.replace(/-/g, "_")}_${action}`;
      const supported = Object.keys(operation.responses).some(status => status.startsWith("2"));
      const matches = tools.filter(tool => tool.name === name || tool.name === `${name}_read` || tool.name === `${name}_write`);
      expect(matches.length, name).toBe(supported ? stage === "campaigns" && action === "post" ? 2 : 1 : 0);
      for (const tool of matches) {
        expect(tool.title.length).toBeGreaterThan(0);
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
        expect(tool.inputSchema.properties.path).toEqual(operation.request.path);
        expect(tool.inputSchema.properties.query).toEqual(operation.request.query);
        if (!(stage === "campaigns" && action === "post") && operation.request.body) expect(tool.inputSchema.properties.body).toEqual(operation.request.body);
      }
    }
    expect(tools.find(tool => tool.name === "crm_mapping_sources")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "sending_accounts_client_connect_status")!.annotations.readOnlyHint).toBe(false);
    expect(tools.find(tool => tool.name === "crm_mapping_preview")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "campaigns_post_write")!.annotations.destructiveHint).toBe(true);
    expect(tools.find(tool => tool.name === "campaigns_post_write")!.annotations.openWorldHint).toBe(true);
    expect(tools.find(tool => tool.name === "summary_get")!.annotations.openWorldHint).toBe(false);
    expect(tools.find(tool => tool.name === "next_step")!.annotations.openWorldHint).toBe(false);
    expect(tools.find(tool => tool.name === "sending_accounts_get")!.inputSchema.required).toContain("query");
  });

  it("keeps authentication, current contract, validation and the shared mutation limiter in the owning REST route", async () => {
    const create = vi.fn(async () => ({ state: "ready_for_connections" as const, workspace, created: true }));
    const auth = vi.fn(async (request: Request) => request.headers.get("authorization") === "Bearer founder"
      ? { ok: true as const, session: { userId: "founder", client: {} } } : { ok: false as const, reason: "invalid_session" as const });
    const app = createApp({ authenticate: auth, createWorkspace: create, log: () => {} });
    const dispatch = (route: string, init: RequestInit) => Promise.resolve(app.request(route, init));
    const input = { body: { name: "Example" } };
    expect((await callStageMcpTool("business_post", input, new Request("https://example.test/mcp"), dispatch)).structuredContent.status).toBe(401);
    const old = incoming(); old.headers.set("x-lifty-client-contract", "lifty-cli-context.v4");
    expect((await callStageMcpTool("business_post", input, old, dispatch)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) expect((await callStageMcpTool("business_post", input, incoming(), dispatch)).isError).toBe(false);
    const limited = await callStageMcpTool("business_post", input, incoming(), dispatch);
    expect(limited.structuredContent).toMatchObject({ status: 429, retry_after_seconds: 60 });
    expect(create).toHaveBeenCalledTimes(10);
    expect(auth.mock.calls.at(-1)![0].headers.get("x-lifty-client-contract")).toBe(STAGE_CLIENT_CONTRACT);
  });

  it("cannot dispatch a campaign write through a read tool or replace the route, query, or identity", async () => {
    const dispatch = vi.fn(async () => Response.json({ state: "read" }));
    expect((await callStageMcpTool("campaigns_post_read", { body: { scope: "workspace", request: { operation: "activate", payload: {} } } }, incoming(), dispatch)).isError).toBe(true);
    for (const input of [{ route: "/v1/admin" }, { path: { submission_ref: "../summary" } }, { query: { workspace: "foreign" } }]) {
      expect((await callStageMcpTool("targeting_update_status", input, incoming(), dispatch)).isError).toBe(true);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect((await callStageMcpTool("campaigns_post_read", { body: { channel: "email", request: { operation: "placement-preview", payload: {} } } }, incoming(), dispatch)).isError).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("returns a run receipt immediately and makes progress a separate read", async () => {
    const start = vi.fn(async () => ({ state: "queued" as const, run_ref: "11111111-1111-4111-8111-111111111111", requested_leads: 5, workspace, created: true }));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const read = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      startRun: start, enqueueFirstRun: enqueue, getRunStatus: read, log: () => {} });
    const result = await callStageMcpTool("sample_review_post", { body: {} }, incoming(), (route, init) => Promise.resolve(app.request(route, init)));
    expect(result.structuredContent).toMatchObject({ status: 200, data: { state: "queued", run_ref: "11111111-1111-4111-8111-111111111111" } });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(getStageMcpTools().find(tool => tool.name === "sample_review_progress")!.annotations.readOnlyHint).toBe(true);
  });
});
