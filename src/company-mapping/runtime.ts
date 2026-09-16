import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "../app.js";
import { resolveHubSpotGrant } from "../generated/hubspot-grant-policy.js";
import { FIELDS, MappingError, parsePlan, type Property, type State } from "./contract.js";
import { applyCompanyMapping, companyMappingContext, type MappingTools } from "./service.js";

export const COMPANY_OPERATION_TIMEOUT_MS = 55_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
export interface CompanyMappingSettings {
  serverKey: string;
  fetch?: typeof fetch;
  /** A short injected budget makes timeout recovery deterministic in tests. */
  operationTimeoutMs?: number;
}
export interface CompanyMappingOptions { workspaceRef?: string; signal?: AbortSignal }

const Mapping = z.object({
  source_stage: z.string(), source_entity: z.string(), source_field: z.string(),
  source_path: z.array(z.string()), destination_object: z.string(), destination_field: z.string(),
  write_rule: z.string(), value_source: z.string(), transform: z.string(),
  transform_config: z.record(z.string(), z.unknown()), enabled: z.boolean(),
});
const StateSchema = z.object({
  workspace_ref: z.uuid(), workspace_name: z.string(), portal_id: z.string().regex(/^\d{1,30}$/),
  integration_ref: z.uuid(), mapping_version: z.string().regex(/^[a-f0-9]{64}$/), mappings: z.array(Mapping),
});
const PropertySchema = z.object({
  name: z.string(), label: z.string(), description: z.string().optional(),
  type: z.string(), fieldType: z.string(), groupName: z.string().optional(), archived: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string(), hidden: z.boolean().optional(), displayOrder: z.number().optional() }).passthrough()).optional(),
  modificationMetadata: z.object({ readOnlyValue: z.boolean().optional(), readOnlyOptions: z.boolean().optional(), readOnlyDefinition: z.boolean().optional() }).optional(),
});
const Credential = z.object({
  secret: z.string().min(1), credential_version: z.string().regex(/^[a-f0-9]{64}$/),
  workspace_ref: z.uuid(), integration_ref: z.uuid(), portal_id: z.string(),
});
const RpcResult = z.object({ data: z.unknown(), error: z.unknown().nullable() });
const RpcError = z.object({ code: z.string().optional(), message: z.string().optional() });

function storageError(error: unknown): MappingError {
  const value = RpcError.safeParse(error);
  const names: Record<string, string> = {
    unauthenticated: "UNAUTHORIZED", lifty_crm_service_forbidden: "COMPANY_MAPPING_NOT_CONFIGURED",
    lifty_workspace_ambiguous: "WORKSPACE_AMBIGUOUS", lifty_workspace_missing: "WORKSPACE_NOT_READY",
    lifty_workspace_suspended: "WORKSPACE_SUSPENDED", lifty_company_mapping_unsupported: "WORKSPACE_UNSUPPORTED",
    lifty_hubspot_reconnect_required: "HUBSPOT_RECONNECT_REQUIRED", lifty_hubspot_connection_unavailable: "HUBSPOT_NOT_CONNECTED",
    lifty_company_mapping_forbidden: "FORBIDDEN_WORKSPACE", lifty_company_mapping_stale: "STALE_CONTEXT",
    lifty_crm_credential_stale: "STALE_CONTEXT", lifty_company_mapping_conflict: "MAPPING_CONFLICT",
  };
  const code = value.success ? names[value.data.message ?? ""] : undefined;
  if (!code) return new MappingError("MAPPING_STORAGE_FAILED", 502);
  return new MappingError(code, code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN_WORKSPACE" ? 403 : code === "COMPANY_MAPPING_NOT_CONFIGURED" ? 503 : 409);
}

/** A scoped RPC is the only storage authority here; this module has no admin client. */
export async function runCompanyMapping(
  session: AuthSession, settings: CompanyMappingSettings, action: "context" | "apply",
  input?: unknown, options: CompanyMappingOptions = {},
) {
  const plan = action === "apply" ? parsePlan(input) : undefined;
  const workspaceRef = options.workspaceRef ?? plan?.workspace_ref;
  if (workspaceRef !== undefined && !z.uuid().safeParse(workspaceRef).success) throw new MappingError("INVALID_WORKSPACE", 400);
  if (plan && options.workspaceRef && plan.workspace_ref !== options.workspaceRef) throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
  const requestId = randomUUID();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeoutMs = settings.operationTimeoutMs ?? COMPANY_OPERATION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetcher = settings.fetch ?? fetch;
  const client = session.client;
  if (!client || typeof client !== "object" || !("rpc" in client) || typeof client.rpc !== "function") {
    clearTimeout(timer);
    throw new MappingError("MAPPING_STORAGE_FAILED", 502);
  }
  const rpcMethod = client.rpc;
  const checkActive = () => { if (signal.aborted) throw new MappingError("COMPANY_MAPPING_TIMEOUT", 504); };
  async function rpc(operation: string, payload: Record<string, unknown> = {}) {
    checkActive();
    let request: unknown = rpcMethod.call(client, "lifty_crm_company_tools", {
      p_server_key: settings.serverKey, p_operation: operation,
      p_payload: { ...(workspaceRef ? { workspace_ref: workspaceRef } : {}), request_id: requestId, ...payload },
    });
    if (request && typeof request === "object" && "abortSignal" in request && typeof request.abortSignal === "function") request = request.abortSignal(signal);
    const result = RpcResult.safeParse(await request);
    checkActive();
    if (!result.success) throw new MappingError("INVALID_STATE", 502);
    if (result.data.error) throw storageError(result.data.error);
    return result.data.data;
  }
  const scoped = (state: State) => ({ workspace_ref: state.workspace_ref, integration_ref: state.integration_ref, portal_id: state.portal_id });
  const tokens = new Map<string, string>();
  const providerFetch: typeof fetch = async (url, init) => {
    checkActive();
    const result = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)]) });
    checkActive();
    return result;
  };
  async function tokenFor(state: State): Promise<string> {
    const cacheKey = `${state.integration_ref}:${state.portal_id}`;
    const cached = tokens.get(cacheKey);
    if (cached) return cached;
    const parsed = Credential.safeParse(await rpc("credential", scoped(state)));
    if (!parsed.success) throw new MappingError("HUBSPOT_NOT_CONNECTED", 409);
    const credential = parsed.data;
    if (credential.workspace_ref !== state.workspace_ref || credential.integration_ref !== state.integration_ref || credential.portal_id !== state.portal_id) throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
    const resolved = await resolveHubSpotGrant({
      workspaceId: state.workspace_ref, requestId, secret: credential.secret,
      expectedPortalId: state.portal_id, nowEpochSeconds: Math.floor(Date.now() / 1000), fetcher: providerFetch,
    }, {
      rotateGrant: async ({ grant }) => {
        const result = await rpc("rotate", { ...scoped(state), credential_version: credential.credential_version, grant });
        return z.object({ status: z.literal("rotated") }).safeParse(result).success;
      },
      markReconnectRequired: async () => { await rpc("reconnect", { ...scoped(state), credential_version: credential.credential_version }); },
    });
    checkActive();
    if (!resolved.ok || !resolved.token) throw new MappingError("HUBSPOT_RECONNECT_REQUIRED", 409);
    const response = await providerFetch("https://api.hubapi.com/account-info/2026-03/details", { headers: { authorization: `Bearer ${resolved.token}` } });
    const account = z.object({ portalId: z.union([z.string(), z.number()]) }).safeParse(await response.json().catch(() => null));
    if (!response.ok || !account.success || String(account.data.portalId) !== state.portal_id) throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
    tokens.set(cacheKey, resolved.token);
    return resolved.token;
  }
  async function call(state: State, method: "GET" | "POST" | "PATCH", suffix: string, body?: unknown) {
    const token = await tokenFor(state);
    const response = await providerFetch(`https://api.hubapi.com/crm/v3/properties/companies${suffix}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new MappingError("HUBSPOT_RECONNECT_REQUIRED", 409);
    if (response.status === 403) throw new MappingError("HUBSPOT_SCHEMA_PERMISSION_REQUIRED", 409);
    if (response.status === 429) throw new MappingError("HUBSPOT_RATE_LIMITED", 429);
    if (!response.ok && !(method === "POST" && response.status === 409)) throw new MappingError("HUBSPOT_SCHEMA_REQUEST_FAILED", 502);
    return response.json().catch(() => null);
  }
  const tools: MappingTools = {
    state: async () => {
      const value = StateSchema.safeParse(await rpc("state"));
      if (!value.success) throw new MappingError("INVALID_STATE", 502);
      if (workspaceRef && value.data.workspace_ref !== workspaceRef) throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
      return value.data;
    },
    properties: async (state) => {
      const data = z.object({ results: z.array(PropertySchema) }).safeParse(await call(state, "GET", "?archived=false"));
      if (!data.success) throw new MappingError("INVALID_HUBSPOT_SCHEMA", 502);
      return data.data.results.filter((p) => FIELDS.some((field) => field === p.name)).map((p): Property => ({
        name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.options === undefined ? {} : { options: p.options.map(({ hidden, displayOrder, ...option }) => ({ ...option, ...(hidden === undefined ? {} : { hidden }), ...(displayOrder === undefined ? {} : { displayOrder }) })) }),
        ...(p.groupName === undefined ? {} : { groupName: p.groupName }), ...(p.archived === undefined ? {} : { archived: p.archived }),
        ...(p.modificationMetadata === undefined ? {} : { modificationMetadata: Object.fromEntries(Object.entries(p.modificationMetadata).filter(([, value]) => value !== undefined)) }),
      }));
    },
    createProperty: async (state, property) => { await call(state, "POST", "", property); },
    addOptions: async (state, property) => { await call(state, "PATCH", `/${encodeURIComponent(property.name)}`, { options: property.options }); },
    publish: async (state, rows) => { await rpc("publish", { ...scoped(state), mapping_version: state.mapping_version, rows }); },
  };
  let onAbort: (() => void) | undefined;
  try {
    checkActive();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new MappingError("COMPANY_MAPPING_TIMEOUT", 504));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = action === "context" ? companyMappingContext(tools) : applyCompanyMapping(plan, tools);
    return await Promise.race([result, aborted]);
  } catch (error) {
    if (signal.aborted) throw new MappingError("COMPANY_MAPPING_TIMEOUT", 504);
    if (error instanceof MappingError) throw error;
    throw new MappingError("COMPANY_MAPPING_UNAVAILABLE", 502);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
