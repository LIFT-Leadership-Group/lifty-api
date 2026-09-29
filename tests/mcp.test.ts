import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { handleMcpRequest } from "../src/mcp.js";

const settings = { resourceUrl: "https://api.lifty.test/mcp", authorizationServer: "https://project.supabase.test/auth/v1", allowedOrigins: ["https://api.lifty.test"] };
const authentication = async (request: Request) => request.headers.get("authorization")?.startsWith("Bearer founder-")
  ? { ok: true as const, session: { userId: request.headers.get("authorization")!.slice(7), client: {} } }
  : { ok: false as const, reason: "invalid_session" as const };
const post = (method: string, params?: unknown, headers: Record<string, string> = {}) => new Request(settings.resourceUrl, {
  method: "POST", headers: { authorization: "Bearer founder-1", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
});

describe("MCP HTTP boundary", () => {
  it("serves exactly the configured domain challenge token as public text, without requiring MCP enablement", async () => {
    expect((await createApp().request("/.well-known/openai-apps-challenge")).status).toBe(404);
    const app = createApp({ openAiAppsChallenge: "openai-verification=example_token" });
    const response = await app.request("/.well-known/openai-apps-challenge");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("openai-verification=example_token");
  });
  it("is absent by default; publishes canonical discovery and an authentication challenge only when configured", async () => {
    expect((await createApp().request("/mcp")).status).toBe(404);
    expect((await createApp().request("/.well-known/oauth-protected-resource")).status).toBe(404);
    const authenticate = vi.fn(authentication);
    const app = createApp({ mcp: { ...settings, authenticate } });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const metadata = await app.request(`https://untrusted.test${path}`);
      expect(await metadata.json()).toMatchObject({ resource: settings.resourceUrl, authorization_servers: [settings.authorizationServer] });
    }
    expect(authenticate).not.toHaveBeenCalled();
    const response = await app.request("/mcp", { method: "POST", body: "garbage" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('resource_metadata="https://api.lifty.test/.well-known/oauth-protected-resource/mcp"');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("works with the official client without a proprietary header and isolates concurrent founders", async () => {
    const authenticate = vi.fn(authentication);
    const app = createApp({ mcp: { ...settings, authenticate }, authenticate,
      getWorkspace: async () => ({ state: "needs_workspace", workspace: null, next_action: "provision_workspace" }),
      getOnboardingState: async () => ({ state: "none", revision: 0 }) });
    await Promise.all(["founder-1", "founder-2"].map(async userId => {
      const transport = new StreamableHTTPClientTransport(new URL(settings.resourceUrl), {
        requestInit: { headers: { authorization: `Bearer ${userId}` } },
        fetch: async (input, init) => app.request(new Request(input, init)),
      });
      const client = new Client({ name: "integration-proof", version: "1" });
      try {
        // SDK 1.30.1 declares sessionId as string|undefined on this transport
        // but optional string on Transport; runtime is the SDK's own transport.
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        const list = await client.listTools();
        expect(list.tools.length).toBeGreaterThan(40);
        expect(list.tools.every(tool => tool.title && typeof tool.annotations?.readOnlyHint === "boolean")).toBe(true);
        expect(list.tools[0]).toMatchObject({ name: "whoami", annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { securitySchemes: [{ type: "oauth2", scopes: ["openid", "email", "profile"] }] } });
        const result = await client.callTool({ name: "whoami", arguments: {} });
        expect(result.structuredContent).toEqual({ user_id: userId, workspaces: null });
        const next = await client.callTool({ name: "next_step", arguments: {} });
        expect(next.structuredContent).toMatchObject({ status: 200, data: { step: "business", reason: "workspace_missing", guide: { task: "business" } } });
        expect(JSON.stringify(result)).not.toContain("Bearer");
        expect(transport.sessionId).toBeUndefined();
      } finally { await client.close(); }
    }));
    // Each transport call, including initialization and notifications, authenticates anew.
    expect(authenticate.mock.calls.length).toBeGreaterThanOrEqual(8);
  });

  it("whoami lists only the caller's workspaces and reports an unreadable list as unknown", async () => {
    const lift = { workspace_ref: "22222222-2222-4222-8222-222222222222", slug: "lift", name: "LIFT", active: true, founder_default: true, self_service: true };
    const listMemberWorkspaces = vi.fn(async (session: { userId: string }) => {
      if (session.userId === "founder-broken") throw new Error("database unavailable");
      return { workspaces: session.userId === "founder-1" ? [lift, { ...lift, workspace_ref: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme", founder_default: false }] : [lift] };
    });
    const app = createApp({ mcp: { ...settings, authenticate: authentication }, listMemberWorkspaces, log: () => {} });
    const whoami = async (userId: string) => (await (await app.request(post("tools/call", { name: "whoami", arguments: {} }, { authorization: `Bearer ${userId}` }))).json()).result.structuredContent;
    expect((await whoami("founder-1")).workspaces.map((workspace: { slug: string }) => workspace.slug)).toEqual(["lift", "acme"]);
    expect(await whoami("founder-2")).toEqual({ user_id: "founder-2", workspaces: [lift] });
    expect(await whoami("founder-broken")).toEqual({ user_id: "founder-broken", workspaces: null });
    expect(listMemberWorkspaces.mock.calls.map(([session]) => session.userId)).toEqual(["founder-1", "founder-2", "founder-broken"]);
  });

  it("returns a relinking challenge if the REST session is revoked after MCP authentication", async () => {
    const app = createApp({ mcp: { ...settings, authenticate: authentication }, log: () => {} });
    const response = await app.request(post("tools/call", { name: "business_get", arguments: {} }));
    const payload = await response.json();
    expect(payload.result).toMatchObject({ isError: true, structuredContent: { status: 401 } });
    expect(payload.result._meta["mcp/www_authenticate"][0]).toContain("resource_metadata");
    expect(payload.result._meta["mcp/www_authenticate"][0]).toContain('error="invalid_token"');
    expect(payload.result._meta["mcp/www_authenticate"][0]).toContain('error_description="');
  });

  it("rejects unsupported contracts, origins, methods, invalid tools and oversized bodies before execution", async () => {
    const authenticate = vi.fn(authentication);
    const dependencies = { ...settings, authenticate };
    expect((await handleMcpRequest(post("tools/list", undefined, { origin: "https://attacker.test" }), dependencies)).status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect((await handleMcpRequest(post("tools/list", undefined, { "x-lifty-client-contract": "retired" }), dependencies)).status).toBe(409);
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcpRequest(new Request(settings.resourceUrl, { method, headers: { authorization: "Bearer founder-1" } }), dependencies);
      expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("POST");
    }
    for (const params of [{ name: "unknown" }, { name: "whoami", arguments: { workspace_id: "foreign" } }]) {
      const response = await handleMcpRequest(post("tools/call", params), dependencies);
      expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    }
    const oversized = post("tools/call", { name: "whoami", arguments: { data: "x".repeat(161 * 1024) } });
    expect((await handleMcpRequest(oversized, dependencies)).status).toBe(413);
  });
});
