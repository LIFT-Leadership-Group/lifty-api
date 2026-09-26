import { readSenderRoster } from "./sender-choice.js";
import { getWorkspaceSummary, readComponent } from "./workspace-summary.js";
import { BusinessWebsiteSchema } from "./business-website.js";
import { CrmRecordsQuerySchema, CrmRecordsSchema } from "./crm-records.js";
import {
  CrmMappingCatalogSchema, CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema,
  CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema, CrmMappingApplyRequestSchema,
  CrmMappingApplySchema, CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema,
  CrmMappingSyncRequestSchema, CrmMappingSyncSchema, CrmMappingStatusQuerySchema, CrmMappingStatusSchema,
  type CrmMappingAction,
} from "./crm-mapping/contracts.js";
import { z } from "zod";
import { workspaceCampaignResultFor } from "./workspace-campaign-contracts.js";
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppDependencies, AppEnvironment } from "./app.js";
import type { ConnectionProvider } from "./connection-attempt.js";
import { PublicError } from "./errors.js";
import { CompanyPlanSchema } from "./company-mapping/contract.js";
import { EmailConnectionStatus } from "./email-contracts.js";
import { LinkedinConnectionStatus } from "./linkedin-contracts.js";
import {
  HubspotConnectionStatusSchema, NotificationConfigSchema, WorkspaceConfigSchema,
  WorkspaceStatusSchema, SubmitOnboardingRequestSchema, CreateWorkspaceRequestSchema,
} from "./contracts.js";
import {
  AuthorizationRequiredSchema, BusinessStagePatchSchema, BusinessStageSchema,
  CampaignStagePatchSchema, CampaignStageQuerySchema, CampaignStageRequestSchema,
  CapacityStageSchema, ConnectionAttemptQuerySchema, ConnectionAttemptStatusSchema,
  NotificationStagePatchSchema, ResearchStagePatchSchema, SendingAccountQuerySchema,
  SendingAccountStartSchema, TargetingStagePatchSchema, VoiceStagePatchSchema, stageOperations,
} from "./stage-contracts.js";

const Empty = z.object({}).strict();
const MAX_STAGE_BYTES = 132 * 1024;
const invalid = () => new PublicError({ status: 400, code: "INVALID_REQUEST", message: "Use the current stage request schema and supported fields." });
const forbidden = () => new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "This operation belongs to the current Lifty workspace." });

async function readBody(context: Context<AppEnvironment>): Promise<unknown> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STAGE_BYTES) {
        await reader.cancel();
        throw new PublicError({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "The stage request exceeds 132 KiB." });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalid(); }
}
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function registerStageRoutes(app: OpenAPIHono<AppEnvironment>, dependencies: AppDependencies): void {
  // Dispatch locally into the existing route: its authentication, rate limit,
  // body limit, business validation, jobs and receipt projection run unchanged.
  function forward(context: Context<AppEnvironment>, method: string, route: string, body?: unknown) {
    const headers = new Headers();
    for (const name of ["authorization", "x-lifty-client-contract", "x-request-id"]) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    return app.request(route, { method, headers, signal: context.req.raw.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function workspace(context: Context<AppEnvironment>) {
    const state = WorkspaceStatusSchema.parse(await dependencies.getWorkspace(context.get("authSession")));
    if (state.state === "needs_workspace") throw new PublicError({ status: 409, code: "WORKSPACE_NOT_READY", message: "Create the Lifty workspace before configuring this stage." });
    if (state.state === "suspended") throw new PublicError({ status: 409, code: "WORKSPACE_SUSPENDED", message: "This workspace is suspended. Contact LIFT support." });
    return state.workspace.workspace_ref;
  }
  async function attempt(context: Context<AppEnvironment>, provider: ConnectionProvider, ref: string, workspaceRef: string) {
    parse(z.uuid(), ref);
    const session = context.get("authSession");
    let result = await dependencies.getConnectionAttempt(session, provider, ref, workspaceRef);
    if ((provider === "email" || provider === "linkedin") && result.status === "pending") {
      // Reconcile a callback hint/read provider health without mistaking the old
      // grant for this attempt. A read failure throws and never invents a state.
      if (provider === "email") await dependencies.getEmailConnection(session, workspaceRef, ref);
      else await dependencies.getLinkedinConnection(session, workspaceRef, ref);
      result = await dependencies.getConnectionAttempt(session, provider, ref, workspaceRef);
    }
    if (result.attempt_ref !== ref) throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization could not be verified. Retry the same attempt." });
    return context.json(ConnectionAttemptStatusSchema.parse(result));
  }
  const authorization = (value: { attempt_ref?: string | undefined; intent_ref?: string | undefined; connect_url: string; expires_at?: string | undefined }) => {
    const ref = value.attempt_ref ?? value.intent_ref;
    if (!z.uuid().safeParse(ref).success || !value.expires_at) {
      throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The connection service cannot yet verify this authorization attempt. Retry after the service update." });
    }
    return AuthorizationRequiredSchema.parse({ status: "authorization_required", attempt_ref: ref,
      connection_url: value.connect_url, expires_at: value.expires_at });
  };

  app.get("/v1/workspace/crm/records", async context => {
    context.header("cache-control", "no-store");
    const query = parse(CrmRecordsQuerySchema, context.req.query());
    const current = await workspace(context);
    const result = CrmRecordsSchema.parse(await dependencies.runCrmMapping(context.get("authSession"), "records", query, {
      workspaceRef: current, signal: context.req.raw.signal,
    }));
    if (result.workspace_ref !== current) throw forbidden();
    return context.json(result);
  });

  async function mapping(context: Context<AppEnvironment>, action: CrmMappingAction, input: unknown, responseSchema: z.ZodType) {
    context.header("cache-control", "no-store");
    const current = await workspace(context);
    // Input schemas may carry the catalog's immutable scope for optimistic
    // checks. It must still refer to this authenticated current workspace.
    if (input && typeof input === "object" && "workspace_ref" in input && input.workspace_ref !== current) throw forbidden();
    const result = responseSchema.parse(await dependencies.runCrmMapping(context.get("authSession"), action, input, {
      workspaceRef: current, signal: context.req.raw.signal,
    }));
    if (!result || typeof result !== "object" || !("workspace_ref" in result) || result.workspace_ref !== current) throw forbidden();
    return context.json(result);
  }
  app.get("/v1/workspace/crm/mapping/catalog", context =>
    mapping(context, "catalog", parse(Empty, context.req.query()), CrmMappingCatalogSchema));
  app.get("/v1/workspace/crm/mapping/status", context =>
    mapping(context, "status", parse(CrmMappingStatusQuerySchema, context.req.query()), CrmMappingStatusSchema));
  for (const [action, requestSchema, responseSchema] of [
    ["sources", CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema],
    ["preview", CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema],
    ["apply", CrmMappingApplyRequestSchema, CrmMappingApplySchema],
    ["property_create", CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema],
    ["sync", CrmMappingSyncRequestSchema, CrmMappingSyncSchema],
  ] as const) {
    app.post(`/v1/workspace/crm/mapping/${action}`, async context => {
      parse(Empty, context.req.query());
      return mapping(context, action, parse(requestSchema, await readBody(context)), responseSchema);
    });
  }

  // Current-workspace mapping context keeps arbitrary member-workspace selection
  // out of the generic stage flow; the legacy admin route remains separate.
  app.get("/v1/workspace/crm/mapping-context", async context => {
    parse(Empty, context.req.query());
    const current = await workspace(context);
    return forward(context, "GET", `/v1/integrations/hubspot/company-mapping/context?workspace_ref=${encodeURIComponent(current)}`);
  });

  app.get("/v1/workspace/sending-accounts/senders", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    return context.json(await readSenderRoster(context.get("authSession"), await workspace(context)));
  });

  for (const stage of Object.keys(stageOperations)) {
    app.get(`/v1/workspace/${stage}`, async context => {
      context.header("cache-control", "no-store");
      const session = context.get("authSession");
      if (stage === "summary") {
        parse(Empty, context.req.query());
        return context.json(await getWorkspaceSummary(dependencies, session));
      }
      if (stage === "business") {
        parse(Empty, context.req.query());
        const state = WorkspaceStatusSchema.parse(await dependencies.getWorkspace(session));
        return context.json(BusinessStageSchema.parse({ workspace: state,
          configuration: state.state === "needs_workspace" ? null : await dependencies.getConfig(session, "workspace"),
          website: state.state === "needs_workspace" ? null : await readComponent(async () => {
            const value = BusinessWebsiteSchema.parse(await dependencies.getBusinessWebsite(session));
            if (value.workspace_ref !== state.workspace.workspace_ref) throw forbidden();
            return value;
          }) }));
      }
      const current = await workspace(context);
      if (stage === "crm" || stage === "notifications") {
        const query = parse(ConnectionAttemptQuerySchema, context.req.query());
        if (query.attempt_ref) return attempt(context, stage === "crm" ? "hubspot" : "slack", query.attempt_ref, current);
        return stage === "crm" ? context.json(HubspotConnectionStatusSchema.parse(await dependencies.getHubspotConnection(session)))
          : context.json(NotificationConfigSchema.parse(await dependencies.getNotificationConfig(session)));
      }
      if (stage === "sending-accounts") {
        const query = parse(SendingAccountQuerySchema, context.req.query());
        if (query.attempt_ref) return attempt(context, query.channel, query.attempt_ref, current);
        return query.channel === "email" ? context.json(EmailConnectionStatus.parse(await dependencies.getEmailConnection(session, current)))
          : context.json(LinkedinConnectionStatus.parse(await dependencies.getLinkedinConnection(session, current)));
      }
      if (stage === "campaigns") {
        const query = parse(CampaignStageQuerySchema, context.req.query());
        if ("scope" in query) {
          const input = { operation: query.operation, payload: { workspace: current } };
          return context.json(workspaceCampaignResultFor(input, await dependencies.workspaceCampaign(session, input)));
        }
        if (query.workspace !== current) throw forbidden();
        return forward(context, "POST", query.channel === "email" ? "/v1/email/campaign" : "/v1/linkedin/campaign",
          { operation: query.operation, payload: { workspace: current, campaign_ref: query.campaign_ref } });
      }
      parse(Empty, context.req.query());
      if (stage === "capacity") return context.json(CapacityStageSchema.parse({
        configuration: await dependencies.getConfig(session, "workspace"), allowance: await dependencies.getApolloAllowance(session, current),
      }));
      if (stage === "sample-review") return forward(context, "GET", "/v1/workspace/runs");
      const section = stage === "targeting" ? "icp" : stage === "research-criteria" ? "prompt" : "tone";
      return context.json(WorkspaceConfigSchema.parse(await dependencies.getConfig(session, section)));
    });

    app.post(`/v1/workspace/${stage}`, async context => {
      parse(Empty, context.req.query());
      if (stage === "capacity" || stage === "summary") throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This stage is read-only." });
      const body = await readBody(context);
      if (stage === "business") return forward(context, "POST", "/v1/workspace", parse(CreateWorkspaceRequestSchema, body));
      const current = await workspace(context);
      const session = context.get("authSession");
      if (["targeting", "research-criteria", "commercial-voice"].includes(stage)) {
        return forward(context, "POST", "/v1/onboarding", parse(SubmitOnboardingRequestSchema, body));
      }
      if (stage === "campaigns") {
        const input = parse(CampaignStageRequestSchema, body);
        if (input.request.payload.workspace !== current) throw forbidden();
        if ("scope" in input) return context.json(workspaceCampaignResultFor(input.request,
          await dependencies.workspaceCampaign(context.get("authSession"), input.request)));
        return forward(context, "POST", input.channel === "email" ? "/v1/email/campaign" : "/v1/linkedin/campaign", input.request);
      }
      if (stage === "sending-accounts") {
        const input = parse(SendingAccountStartSchema, body);
        const result = input.channel === "email"
          ? await dependencies.startEmailConnect(session, { workspace: current, reconnect: true,
            ...(input.sender ? { sender: input.sender } : {}),
            ...(input.select_account === undefined ? {} : { select_account: input.select_account }) })
          : await dependencies.startLinkedinConnect(session, { workspace: current, timezone: input.timezone,
            account_use: input.account_use, other_automation: input.other_automation, reconnect: true,
            ...(input.sender ? { sender: input.sender } : {}) });
        if (result.status !== "pending") throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The new authorization attempt could not be started." });
        return context.json(authorization(result));
      }
      parse(Empty, body);
      if (stage === "crm") return context.json(authorization(await dependencies.startHubspotConnect(session)));
      if (stage === "notifications") return context.json(authorization(await dependencies.startSlackConnect(session)));
      return forward(context, "POST", "/v1/workspace/runs");
    });

    app.patch(`/v1/workspace/${stage}`, async context => {
      parse(Empty, context.req.query());
      if (["summary", "capacity", "sample-review", "sending-accounts"].includes(stage)) {
        throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This stage has no supported configuration changes through PATCH." });
      }
      const current = await workspace(context);
      const body = await readBody(context);
      if (stage === "crm") {
        const plan = parse(CompanyPlanSchema, body);
        if (plan.workspace_ref !== current) throw forbidden();
        return forward(context, "POST", "/v1/integrations/hubspot/company-mapping", plan);
      }
      if (stage === "campaigns") {
        const input = parse(CampaignStagePatchSchema, body);
        if (input.request.payload.workspace !== current) throw forbidden();
        if ("scope" in input) return context.json(workspaceCampaignResultFor(input.request,
          await dependencies.workspaceCampaign(context.get("authSession"), input.request)));
        return forward(context, "POST", input.channel === "email" ? "/v1/email/campaign" : "/v1/linkedin/campaign", input.request);
      }
      if (stage === "notifications") {
        const input = parse(NotificationStagePatchSchema, body);
        return forward(context, "PUT", input.operation === "destination" ? "/v1/notifications/destinations/slack" : "/v1/notifications/routes", input.values);
      }
      if (stage === "business") {
        const input = parse(BusinessStagePatchSchema, body);
        if (input.section === "website") {
          const result = BusinessWebsiteSchema.parse(await dependencies.setBusinessWebsite(context.get("authSession"), input));
          if (result.workspace_ref !== current) throw forbidden();
          return context.json(result);
        }
        return forward(context, "PATCH", "/v1/config", input);
      }
      const schema = stage === "targeting" ? TargetingStagePatchSchema
        : stage === "research-criteria" ? ResearchStagePatchSchema : VoiceStagePatchSchema;
      return forward(context, "PATCH", "/v1/config", parse(schema, body));
    });
  }
}
