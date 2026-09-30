import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { callStageMcpTool, getStageMcpTools } from "../src/mcp-stage-tools.js";
import { stageOperations } from "../src/stage-contracts.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";

const incoming = () => new Request("https://api.example.test/mcp", { headers: { authorization: "Bearer founder" } });
const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" };

const withoutDialect = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutDialect)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema")
    .map(([key, item]) => [key, withoutDialect(item)])) : value;

describe("generated MCP stage operations", () => {
  it("covers every supported operation with unique annotated tools and the canonical schema", () => {
    const tools = getStageMcpTools();
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    // An operation several stages share is listed once, under its first stage.
    const firstStage = new Map<string, string>();
    for (const [stage, operations] of Object.entries(stageOperations)) for (const operation of Object.values(operations)) {
      if (!firstStage.has(`${operation.method} ${operation.route}`)) firstStage.set(`${operation.method} ${operation.route}`, stage);
    }
    for (const [stage, operations] of Object.entries(stageOperations)) for (const [action, operation] of Object.entries(operations)) {
      const listedStage = firstStage.get(`${operation.method} ${operation.route}`)!;
      const name = stage === "summary" && action === "next_step" ? "next_step" : `${listedStage.replace(/-/g, "_")}_${action}`;
      const supported = Object.keys(operation.responses).some(status => status.startsWith("2"));
      const matches = tools.filter(tool => tool.name === name || tool.name === `${name}_read` || tool.name === `${name}_write`);
      const split = stage === "campaigns" && ["post", "client_email", "client_linkedin"].includes(action);
      expect(matches.length, name).toBe(supported ? split ? 2 : 1 : 0);
      for (const tool of matches) {
        expect(tool.title.length).toBeGreaterThan(0);
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
        expect(tool.inputSchema.properties.path).toEqual(withoutDialect(operation.request.path));
        expect(tool.inputSchema.properties.query).toEqual(withoutDialect(operation.request.query));
        if (!split && operation.request.body) expect(tool.inputSchema.properties.body).toEqual(withoutDialect(operation.request.body));
      }
    }
    expect(JSON.stringify(tools)).not.toContain("$schema");
    expect(tools.find(tool => tool.name === "business_onboarding_save")!.description).toContain("One tool serves the business, targeting, research-criteria, commercial-voice stages.");
    for (const alias of ["targeting_onboarding_save", "research_criteria_generation_context", "commercial_voice_onboarding_status"]) {
      expect(tools.some(tool => tool.name === alias), alias).toBe(false);
    }
    // Every turn of a connector carries this list; keep it bounded.
    expect(JSON.stringify(tools).length).toBeLessThan(190_000);
    expect(tools.find(tool => tool.name === "crm_mapping_sources")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "sending_accounts_deliverability")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
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

  it("requires write permission for account checks that reconcile or remove provider duplicates", () => {
    const tools = getStageMcpTools();
    for (const name of ["summary_get", "sending_accounts_get", "sending_accounts_client_connect_status"]) {
      expect(tools.find(tool => tool.name === name)!.annotations, name).toMatchObject({
        readOnlyHint: false, destructiveHint: true, openWorldHint: false,
      });
    }
    for (const name of ["summary_get", "sending_accounts_get"]) {
      expect(tools.find(tool => tool.name === name)!.description).toContain("remove unreferenced duplicate LinkedIn provider accounts");
    }
    for (const name of ["next_step", "crm_get", "notifications_get"]) {
      expect(tools.find(tool => tool.name === name)!.annotations, name).toMatchObject({
        readOnlyHint: true, destructiveHint: false, openWorldHint: false,
      });
    }
  });

  it("keeps unlisted shared-operation aliases callable for clients with an older tool list", async () => {
    const dispatch = vi.fn(async (_route: string, _init: RequestInit) => Response.json({ state: "none", revision: 0 }));
    const result = await callStageMcpTool("research_criteria_onboarding_state", {}, incoming(), dispatch);
    expect(result.isError).toBe(false);
    expect(dispatch.mock.calls[0]![0]).toBe("/v1/onboarding/state");
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

  it("exposes every Lifty CLI API capability as a tool on the route the CLI calls", () => {
    const tools = new Map(getStageMcpTools().map(tool => [tool.name, tool]));
    const operationFor = (name: string) => Object.entries(stageOperations).flatMap(([stage, operations]) =>
      Object.entries(operations).filter(([action]) => name.startsWith(`${stage.replace(/-/g, "_")}_${action}`)).map(([, operation]) => operation))[0];
    // CLI command -> [tool, method, route]. Commands that only touch local files
    // (install, login loopback, artifacts) have no connector equivalent.
    const cli: Record<string, [string, string, string]> = {
      // LIF-1137: status and summary are one read.
      "status | get summary": ["summary_get", "GET", "/v1/workspace/summary"],
      "disconnect hubspot": ["crm_disconnect", "POST", "/v1/workspace/crm/disconnect"],
      "disconnect slack": ["notifications_disconnect", "POST", "/v1/workspace/notifications/disconnect"],
      "disconnect unipile": ["sending_accounts_disconnect", "POST", "/v1/workspace/sending-accounts/disconnect"],
      "disconnect unipile --workspace": ["sending_accounts_client_email_disconnect", "POST", "/v1/email/disconnect"],
      "disconnect linkedin --workspace": ["sending_accounts_client_linkedin_disconnect", "POST", "/v1/linkedin/disconnect"],
      "connect linkedin --workspace": ["sending_accounts_client_linkedin_connect", "POST", "/v1/linkedin/connect"],
      "connect linkedin --workspace --status": ["sending_accounts_client_linkedin_status", "GET", "/v1/linkedin"],
      "email deliverability --workspace": ["sending_accounts_deliverability", "GET", "/v1/email/deliverability"],
      "notifications test": ["notifications_test", "POST", "/v1/notifications/destinations/{destination_ref}/test"],
      "get allowance --workspace": ["capacity_allowance", "GET", "/v1/workspaces/{workspace_ref}/apollo/allowance"],
      "apollo status": ["capacity_apollo_key_status", "GET", "/v1/workspaces/{workspace_ref}/integrations/apollo/key-source"],
      "apollo platform-default": ["capacity_apollo_platform_default", "POST", "/v1/workspaces/{workspace_ref}/integrations/apollo/platform-default"],
      "apollo recovery status": ["capacity_apollo_recovery_status", "GET", "/v1/workspaces/{workspace_ref}/apollo/recovery/{first_run_ref}"],
      "apollo recovery request|restart": ["capacity_apollo_recovery", "POST", "/v1/workspaces/{workspace_ref}/apollo/recovery/{first_run_ref}"],
      "workspace retire": ["business_retire", "POST", "/v1/workspaces/{workspace_ref}/retire"],
      "campaign --workspace (read)": ["campaigns_client_email_read", "POST", "/v1/email/campaign"],
      "campaign --workspace (write)": ["campaigns_client_email_write", "POST", "/v1/email/campaign"],
      "campaign linkedin --workspace (read)": ["campaigns_client_linkedin_read", "POST", "/v1/linkedin/campaign"],
      "campaign linkedin --workspace (write)": ["campaigns_client_linkedin_write", "POST", "/v1/linkedin/campaign"],
      "crm companies context --workspace": ["crm_client_mapping_context", "GET", "/v1/integrations/hubspot/company-mapping/context"],
      "crm companies apply --workspace": ["crm_client_mapping_apply", "POST", "/v1/integrations/hubspot/company-mapping"],
    };
    for (const [command, [name, method, route]] of Object.entries(cli)) {
      expect(tools.has(name), command).toBe(true);
      expect(operationFor(name), command).toMatchObject({ method, route });
    }
    const annotations = (name: string) => tools.get(name)!.annotations;
    for (const name of ["crm_disconnect", "notifications_disconnect", "sending_accounts_disconnect", "business_retire",
      "sending_accounts_client_email_disconnect", "sending_accounts_client_linkedin_disconnect", "capacity_apollo_platform_default"]) {
      expect(annotations(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    }
    for (const name of ["notifications_test", "capacity_apollo_recovery", "campaigns_client_email_write", "campaigns_client_linkedin_write"]) {
      expect(annotations(name), name).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    }
    for (const name of ["capacity_allowance", "capacity_apollo_key_status", "capacity_apollo_recovery_status",
      "crm_client_mapping_context", "campaigns_client_email_read", "campaigns_client_linkedin_read"]) {
      expect(annotations(name), name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    // Both GETs check provider connections and can update saved health.
    for (const name of ["summary_get", "sending_accounts_client_linkedin_status"]) expect(annotations(name).readOnlyHint, name).toBe(false);
    expect(tools.has("summary_status")).toBe(false);
    // A customer-owned Apollo key is a secret and never enters a chat tool.
    expect(JSON.stringify(tools.get("capacity_apollo_platform_default")!.inputSchema)).not.toContain("api_key");
    expect(JSON.stringify(tools.get("capacity_apollo_recovery")!.inputSchema)).not.toContain("\"status\"");
  });

  it("disconnects only the current workspace through the existing handlers", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const disconnectIntegration = vi.fn(async (_session: unknown, provider: "hubspot" | "slack") => ({ provider, status: "disconnected" as const,
      portal_id: null, disconnected_at: "2026-09-28T00:00:00Z", workspace, revocation_ref: null }));
    const disconnectEmail = vi.fn(async (_session: unknown, _workspace: string) => ({ provider: "unipile" as const, channel: "email" as const,
      workspace_ref: workspace.workspace_ref, status: "not_connected" as const }));
    const disconnectLinkedin = vi.fn(async (_session: unknown, _workspace: string) => ({ provider: "unipile" as const, channel: "linkedin" as const,
      workspace_ref: workspace.workspace_ref, status: "not_connected" as const }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      disconnectIntegration, disconnectEmail, disconnectLinkedin, enqueueIntegrationRevocation: vi.fn(), log: () => {} } as never);
    const dispatch = (route: string, init: RequestInit) => Promise.resolve(app.request(route, init));
    const call = (name: string, args: unknown) => callStageMcpTool(name, args, incoming(), dispatch);

    expect((await call("crm_disconnect", { body: {} })).structuredContent).toMatchObject({ status: 200, data: { provider: "hubspot", status: "disconnected" } });
    expect((await call("notifications_disconnect", { body: {} })).structuredContent).toMatchObject({ status: 200, data: { provider: "slack" } });
    expect(disconnectIntegration.mock.calls.map(([, provider]) => provider)).toEqual(["hubspot", "slack"]);
    expect((await call("crm_disconnect", { body: { workspace: other } })).isError).toBe(true);

    expect((await call("sending_accounts_disconnect", { body: { channel: "email", confirm: true } })).isError).toBe(false);
    expect((await call("sending_accounts_disconnect", { body: { channel: "linkedin", confirm: true } })).isError).toBe(false);
    expect(disconnectEmail).toHaveBeenCalledWith(expect.anything(), workspace.workspace_ref);
    expect(disconnectLinkedin).toHaveBeenCalledWith(expect.anything(), workspace.workspace_ref);
    for (const body of [{ channel: "email" }, { channel: "email", confirm: true, workspace: other }]) {
      expect((await call("sending_accounts_disconnect", { body })).isError).toBe(true);
    }
    expect(disconnectEmail).toHaveBeenCalledOnce();
    expect(disconnectLinkedin).toHaveBeenCalledOnce();
  });

  it("keeps sends out of the client campaign read tools and Apollo keys out of the key-source tool", async () => {
    const dispatch = vi.fn(async () => Response.json({ state: "ok" }));
    const payload = { workspace: "client", campaign_ref: "11111111-1111-4111-8111-111111111111", digest: "a".repeat(64) };
    expect((await callStageMcpTool("campaigns_client_email_read", { body: { operation: "activate", payload } }, incoming(), dispatch)).isError).toBe(true);
    expect((await callStageMcpTool("campaigns_client_linkedin_read", { body: { operation: "activate", payload } }, incoming(), dispatch)).isError).toBe(true);
    expect((await callStageMcpTool("campaigns_client_email_write", { body: { operation: "status", payload } }, incoming(), dispatch)).isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect((await callStageMcpTool("campaigns_client_email_read", { body: { operation: "status", payload } }, incoming(), dispatch)).isError).toBe(false);
    expect(dispatch).toHaveBeenCalledWith("/v1/email/campaign", expect.objectContaining({ method: "POST" }));

    const credentials = vi.fn(async (_session: unknown, workspace_ref: string) => ({ workspace_ref, tool: "apollo" as const,
      key_source: "platform_default" as const, configured: true, changed: true }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }), apolloCredentials: credentials, log: () => {} } as never);
    const apollo = (body: unknown) => callStageMcpTool("capacity_apollo_platform_default", { path: { workspace_ref: workspace.workspace_ref }, body },
      incoming(), (route, init) => Promise.resolve(app.request(route, init)));
    expect((await apollo({ operation: "own_key", api_key: "secret-value" })).structuredContent).toMatchObject({ status: 400 });
    expect(credentials).not.toHaveBeenCalled();
    expect((await apollo({})).structuredContent).toMatchObject({ status: 200, data: { key_source: "platform_default" } });
    expect(credentials).toHaveBeenCalledWith(expect.anything(), workspace.workspace_ref, { operation: "platform_default" });
  });
});
