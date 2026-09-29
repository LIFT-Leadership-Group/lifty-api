import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AuthSession, AuthenticationResult } from "./app.js";
import type { MemberWorkspacesOutput } from "./member-workspaces.js";
import { CLIENT_UPGRADE_MESSAGE, STAGE_CLIENT_CONTRACT } from "./agent-context.js";

export interface McpSettings {
  /** Canonical public /mcp URL, never derived from request Host. */
  resourceUrl: string;
  authorizationServer: string;
  allowedOrigins: string[];
}

export interface McpDependencies extends McpSettings {
  authenticate(request: Request): Promise<AuthenticationResult>;
}

/** Extension point for tools backed by the same authenticated REST handlers. */
export interface McpToolRegistry {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>, request: Request): Promise<CallToolResult>;
  /** The caller's own workspace memberships, reported by whoami. */
  workspaces?(session: AuthSession): Promise<MemberWorkspacesOutput>;
}

export function mcpResourceMetadata(settings: McpSettings) {
  return {
    resource: settings.resourceUrl,
    resource_name: "Lifty",
    authorization_servers: [settings.authorizationServer],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  };
}

const whoami: Tool = {
  name: "whoami",
  title: "Signed-in Lifty user",
  description: "Return the signed-in Lifty user's ID and the workspaces they belong to. Call this first. With several workspaces and none named, ask which one before reading workspace state. Tools without a workspace parameter act only on the workspace marked founder_default; for any other workspace use tools that take it, such as summary_get with workspace. workspaces is null when the list could not be read; retry instead of assuming one workspace.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: {
    user_id: { type: "string" },
    workspaces: { type: ["array", "null"], items: { type: "object", properties: {
      workspace_ref: { type: "string" }, slug: { type: "string" }, name: { type: "string" }, active: { type: "boolean" }, founder_default: { type: "boolean" }, self_service: { type: "boolean" },
    }, required: ["workspace_ref", "slug", "name", "active", "founder_default", "self_service"], additionalProperties: false } },
  }, required: ["user_id", "workspaces"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function createMcpServer(session: AuthSession, request: Request, settings: McpSettings, registry?: McpToolRegistry) {
  const server = new Server({ name: "lifty", version: "0.1.0" }, { capabilities: { tools: {} } });
  const securitySchemes = [{ type: "oauth2", scopes: ["openid", "email", "profile"] }];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [whoami, ...(registry?.tools ?? [])].map(tool => ({
    ...tool, securitySchemes, _meta: { ...tool._meta, securitySchemes },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === whoami.name) {
      if (params.arguments && Object.keys(params.arguments).length !== 0) {
        throw new McpError(ErrorCode.InvalidParams, "whoami accepts no arguments.");
      }
      // A failed list is unknown, never an empty or single-workspace answer.
      const workspaces = await registry?.workspaces?.(session).then(value => value.workspaces, () => null) ?? null;
      const result = { user_id: session.userId, workspaces };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    if (registry?.tools.some(tool => tool.name === params.name)) {
      const result = await registry.call(params.name, params.arguments ?? {}, request);
      if (result.isError && result.structuredContent?.status === 401) {
        return { ...result, _meta: { ...result._meta, "mcp/www_authenticate": [challenge(settings) + ', error="invalid_token", error_description="The Lifty session is no longer active. Reconnect Lifty."'] } };
      }
      return result;
    }
    throw new McpError(ErrorCode.InvalidParams, "Unknown tool.");
  });
  return server;
}

function challenge(settings: McpSettings) {
  const metadata = new URL("/.well-known/oauth-protected-resource/mcp", settings.resourceUrl);
  return `Bearer resource_metadata="${metadata}", scope="openid email profile"`;
}

export async function handleMcpRequest(request: Request, dependencies: McpDependencies, registry?: McpToolRegistry): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store" });
  const reply = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
  // Browser origins are an explicit allowlist. Server-to-server clients omit it.
  const origin = request.headers.get("origin");
  if (origin && !dependencies.allowedOrigins.includes(origin)) return reply(403, "ORIGIN_NOT_ALLOWED", "Origin not allowed.");
  const authentication = await dependencies.authenticate(request);
  if (!authentication.ok) {
    headers.set("www-authenticate", challenge(dependencies));
    return reply(401, "UNAUTHORIZED", "A valid Lifty OAuth session is required.");
  }
  const contract = request.headers.get("x-lifty-client-contract");
  if (contract !== null && contract !== STAGE_CLIENT_CONTRACT) return reply(409, "CONTEXT_CLIENT_UNSUPPORTED", CLIENT_UPGRADE_MESSAGE);
  if (request.method !== "POST") {
    headers.set("allow", "POST");
    return reply(405, "METHOD_NOT_ALLOWED", "Use POST for the stateless MCP endpoint.");
  }
  // A new server and transport per request prevent session or identity leakage.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 160 * 1024 });
  const server = createMcpServer(authentication.session, request, dependencies, registry);
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("cache-control", "no-store");
    return response;
  } finally {
    // JSON-only responses have completed before handleRequest resolves.
    await server.close();
  }
}
