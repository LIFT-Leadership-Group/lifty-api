import { z } from "zod";
import { STAGE_CLIENT_CONTRACT } from "./agent-context.js";
import { stageOperations, type StageOperation } from "./stage-contracts.js";

type JsonSchema = Record<string, unknown>;
export interface StageMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}
interface Entry { stage: string; action: string; operation: StageOperation; tool: StageMcpTool; campaignRead?: boolean }
export type McpRouteDispatch = (route: string, init: RequestInit) => Promise<Response>;
const campaignReads = new Set(["status", "preview", "placement-status", "placement-preview"]);
const plainObject = (value: unknown): value is JsonSchema => !!value && typeof value === "object" && !Array.isArray(value);
const title = (value: string) => value.replace(/[-_]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

// Split the existing discriminated request, including nested channel unions.
// Every field still comes from the REST contract; there is no second schema.
function campaignBody(schema: JsonSchema, read: boolean): JsonSchema | null {
  const result = { ...schema };
  for (const union of ["anyOf", "oneOf"] as const) {
    const branches = schema[union];
    if (Array.isArray(branches)) {
      const filtered = branches.filter(plainObject).map(branch => campaignBody(branch, read)).filter(value => value !== null);
      if (!filtered.length) return null;
      result[union] = filtered;
    }
  }
  if (plainObject(schema.properties)) {
    const properties = { ...schema.properties };
    const operation = properties.operation;
    if (plainObject(operation)) {
      const values = Array.isArray(operation.enum) ? operation.enum : [operation.const];
      const allowed = values.filter(value => typeof value === "string" && campaignReads.has(value) === read);
      if (!allowed.length) return null;
      const { const: _constant, enum: _enum, ...rest } = operation;
      properties.operation = { ...rest, enum: allowed };
    }
    if (plainObject(properties.request)) {
      const request = campaignBody(properties.request, read);
      if (!request) return null;
      properties.request = request;
    }
    result.properties = properties;
  }
  return result;
}

function entries(): Entry[] {
  return Object.entries(stageOperations).flatMap(([stage, operations]) => Object.entries(operations).flatMap(([action, operation]) => {
    // Published unsupported REST verbs are not actions a founder can perform.
    if (!Object.keys(operation.responses).some(status => status.startsWith("2"))) return [];
    const variants = stage === "campaigns" && action === "post" ? [true, false] : [undefined];
    return variants.map(campaignRead => {
      const read = campaignRead ?? operation.readOnly;
      const name = `${stage.replace(/-/g, "_")}_${action}${campaignRead === undefined ? "" : read ? "_read" : "_write"}`;
      const label = title(name);
      const body = campaignRead === undefined ? operation.request.body : campaignBody(operation.request.body!, campaignRead);
      if (operation.request.body && !body) throw new Error(`Empty MCP request variant: ${name}`);
      const properties: Record<string, unknown> = { path: operation.request.path, query: operation.request.query };
      const required: string[] = [];
      if (Array.isArray(operation.request.path.required) && operation.request.path.required.length) required.push("path");
      if (body) { properties.body = body; required.push("body"); }
      const description = `${operation.description} ${campaignRead === undefined ? "" : read ? "This tool only reads status or previews. " : "This tool changes campaign state; use the read tool for status and previews. "}Use next_step to choose the next onboarding action. Return pending receipts and authorization links immediately; use the matching status/progress tool on a later call. Never treat queued as completed.${read ? "" : " Ask for the founder's approval before this change; campaign activation and placement may send messages."}`;
      return { stage, action, operation,
        ...(campaignRead === undefined ? {} : { campaignRead }),
        tool: { name, title: label, description,
          inputSchema: { type: "object" as const, properties, required, additionalProperties: false as const },
          annotations: { title: label, readOnlyHint: read, destructiveHint: !read, openWorldHint: true } } };
    });
  }));
}

export const getStageMcpTools = (): StageMcpTool[] => entries().map(entry => entry.tool);

const Envelope = z.object({
  path: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/)).default({}),
  query: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
  body: z.unknown().optional(),
}).strict();
function propertyNames(schema: JsonSchema): Set<string> {
  const names = new Set(plainObject(schema.properties) ? Object.keys(schema.properties) : []);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) for (const branch of schema[key].filter(plainObject)) {
      for (const name of propertyNames(branch)) names.add(name);
    }
  }
  return names;
}
function result(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, isError };
}
const invalid = () => result({ error: { code: "INVALID_REQUEST", message: "Use this tool's current path, query and body schema." } }, true);

export async function callStageMcpTool(name: string, args: unknown, request: Request, dispatch: McpRouteDispatch) {
  const entry = entries().find(item => item.tool.name === name);
  if (!entry) return result({ error: { code: "UNKNOWN_TOOL", message: "Refresh the tools list and use an available Lifty tool." } }, true);
  const parsed = Envelope.safeParse(args ?? {});
  if (!parsed.success) return invalid();
  const input = parsed.data;
  const { operation } = entry;
  const pathNames = propertyNames(operation.request.path);
  const queryNames = propertyNames(operation.request.query);
  if (Object.keys(input.path).some(key => !pathNames.has(key)) || Object.keys(input.query).some(key => !queryNames.has(key))) return invalid();
  if (!operation.request.body && input.body !== undefined) return invalid();
  if (entry.campaignRead !== undefined) {
    if (!plainObject(input.body) || !plainObject(input.body.request) || typeof input.body.request.operation !== "string"
      || campaignReads.has(input.body.request.operation) !== entry.campaignRead) return invalid();
  }
  let missingPath = false;
  const route = operation.route.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = input.path[key];
    if (!value) missingPath = true;
    return value ? encodeURIComponent(value) : "";
  });
  if (missingPath) return invalid();
  const query = new URLSearchParams(Object.entries(input.query).map(([key, value]) => [key, String(value)]));
  const headers = new Headers({ accept: "application/json", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT });
  // The MCP adapter is a current API client. The caller cannot override its
  // contract, impersonate another principal, or supply a route/origin.
  for (const key of ["authorization", "x-request-id"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const clientContract = request.headers.get("x-lifty-client-contract");
  if (clientContract && clientContract !== STAGE_CLIENT_CONTRACT) return result({ error: { code: "CONTEXT_CLIENT_UNSUPPORTED", message: "Reconnect Lifty to refresh the client contract." } }, true);
  const body = operation.request.body ? JSON.stringify(input.body ?? {}) : undefined;
  if (body && Buffer.byteLength(body) > 132 * 1024) return result({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request exceeds 132 KiB." } }, true);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await dispatch(`${route}${query.size ? `?${query}` : ""}`, {
    method: operation.method, headers, signal: request.signal, ...(body === undefined ? {} : { body }),
  });
  let data: unknown;
  try { data = await response.json(); } catch { return result({ error: { code: "INVALID_RESPONSE", message: "Lifty could not verify the response. Read status before retrying a write." } }, true); }
  return result({ status: response.status, data,
    ...(response.headers.has("retry-after") ? { retry_after_seconds: Number(response.headers.get("retry-after")) } : {}) }, !response.ok);
}
