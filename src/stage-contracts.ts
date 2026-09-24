import { RunProgressQuerySchema, RunProgressSchema } from "./run-progress.js";
import { BusinessWebsiteSchema, BusinessWebsitePatchSchema } from "./business-website.js";
import { WorkspaceSummarySchema, readResult } from "./workspace-summary.js";
import { CrmRecordsQuerySchema, CrmRecordsSchema } from "./crm-records.js";
import {
  CrmMappingCatalogSchema, CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema,
  CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema, CrmMappingApplyRequestSchema,
  CrmMappingApplySchema, CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema,
  CrmMappingSyncRequestSchema, CrmMappingSyncSchema, CrmMappingStatusQuerySchema, CrmMappingStatusSchema,
} from "./crm-mapping/contracts.js";
import { z } from "zod";
import { WorkspaceCampaignConfigureRequest, WorkspaceCampaignModifyRequest, WorkspaceCampaignRequest, WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import {
  ConfigUpdateGenerationContextSchema, ConfigUpdateRequestSchema, ConfigUpdateResultSchema,
  ConfigUpdateStatusSchema, CreateWorkspaceRequestSchema, CreateWorkspaceResultSchema,
  HubspotConnectionStatusSchema, NotificationConfigSchema, NotificationDestinationSchema,
  NotificationRouteSchema, OnboardingGenerationContextSchema, OnboardingPushResultSchema,
  OnboardingStatusSchema, RunStatusSchema, SetNotificationRouteRequestSchema,
  SlackNotificationChannelsSchema, StartRunResultSchema, SubmitOnboardingRequestSchema,
  UpsertNotificationDestinationRequestSchema, WorkspaceConfigSchema, WorkspaceStatusSchema,
} from "./contracts.js";
import { ApolloAllowanceSchema } from "./apollo-allowance.js";
import { CompanyMappingContextSchema, CompanyMappingReceiptSchema } from "./company-mapping.js";
import { CompanyPlanSchema } from "./company-mapping/contract.js";
import { EmailConnectionStatus } from "./email-contracts.js";
import { LinkedinConnectRequest, LinkedinConnectionStatus } from "./linkedin-contracts.js";
import { EmailCampaignRequest, EmailCampaignResult } from "./email-campaign-contracts.js";
import { LinkedinCampaignRequest, LinkedinCampaignResult } from "./linkedin-campaign-contracts.js";
import { LocalOnboardingConfigurationSchema, LocalConfigUpdateConfigurationSchema } from "./generated/lifty-configuration.js";

// This is the transport envelope, not a client-side business registry. The API
// publishes current operation definitions; clients pass business data unchanged.
const JsonSchema = z.record(z.string(), z.unknown());
const JsonPointer = z.string().regex(/^\/(?:[^~]|~[01])*$/);
const OperationKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const ReceiptInput = z.object({
  path: z.record(z.string(), JsonPointer).optional(),
  query: z.record(z.string(), JsonPointer).optional(),
});
const ReceiptMatch = z.object({ receipt: JsonPointer, response: JsonPointer });
const SubmissionRead = z.object({ operation: OperationKey, input: ReceiptInput,
  match: z.array(ReceiptMatch).min(1).max(8).optional() });
// A finite local-artifact submission protocol, not a stage/business registry.
// State fields, receipt bindings, routes and readback remain API-owned.
export const LocalSubmissionSchema = z.object({
  version: z.literal("lifty-local-submission.v1"),
  artifact: z.literal("onboarding-configuration"),
  status: SubmissionRead.extend({ state: JsonPointer,
    pending: z.array(z.string().min(1)).min(1).max(20),
    succeeded: z.array(z.string().min(1)).min(1).max(20),
    failed: z.array(z.string().min(1)).min(1).max(20),
    match: z.array(ReceiptMatch).min(1).max(8),
    poll_interval_ms: z.number().int().min(1).max(60000),
    timeout_ms: z.number().int().min(1).max(300000),
  }),
  readback: z.array(SubmissionRead).min(1).max(8),
});
export const StageOperationSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH"]),
  route: z.string().regex(/^\/v1\/[A-Za-z0-9_{}\/-]+$/),
  description: z.string().min(1),
  request: z.object({ path: JsonSchema, query: JsonSchema, body: JsonSchema.nullable() }),
  responses: z.record(z.string().regex(/^[1-5][0-9]{2}$/), JsonSchema),
  submission: LocalSubmissionSchema.optional(),
});
export type StageOperation = z.infer<typeof StageOperationSchema>;

export const StageErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), issues: z.array(z.unknown()).optional() }),
  request_id: z.string(),
});
const Empty = z.object({}).strict();
const AttemptRef = z.uuid();
export const AuthorizationRequiredSchema = z.object({
  status: z.literal("authorization_required"),
  attempt_ref: AttemptRef,
  connection_url: z.url(),
  expires_at: z.iso.datetime({ offset: true }),
}).strict();
export const ConnectionAttemptStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), attempt_ref: AttemptRef,
    expires_at: z.iso.datetime({ offset: true }), retry_after_seconds: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("connected"), attempt_ref: AttemptRef,
    verified: z.literal(true) }).strict(),
  z.object({ status: z.enum(["expired", "denied", "failed"]), attempt_ref: AttemptRef,
    error_code: z.string().min(1).optional() }).strict(),
]);
export const ConnectionAttemptQuerySchema = z.object({ attempt_ref: AttemptRef.optional() }).strict();
export const SendingAccountQuerySchema = ConnectionAttemptQuerySchema.extend({ channel: z.enum(["linkedin", "email"]) });
export const SendingAccountStartSchema = z.discriminatedUnion("channel", [
  LinkedinConnectRequest.omit({ workspace: true, reconnect: true }).extend({ channel: z.literal("linkedin") }),
  // The hosted email flow owns account/provider selection. No pre-link address
  // or use questionnaire, credentials, or authorization override is accepted.
  z.object({ channel: z.literal("email"), select_account: z.boolean().optional() }).strict(),
]);
export const BusinessStageSchema = z.object({
  workspace: WorkspaceStatusSchema,
  configuration: WorkspaceConfigSchema.nullable(),
  website: readResult(BusinessWebsiteSchema).nullable(),
}).strict();
export const CapacityStageSchema = z.object({
  configuration: WorkspaceConfigSchema,
  allowance: ApolloAllowanceSchema,
}).strict();
export const NotificationStagePatchSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("destination"), values: UpsertNotificationDestinationRequestSchema }).strict(),
  z.object({ operation: z.literal("route"), values: SetNotificationRouteRequestSchema }).strict(),
]);
export const BusinessStagePatchSchema = z.union([z.object({
  section: z.literal("workspace"), values: CreateWorkspaceRequestSchema.omit({ website_url: true }).partial(),
}).strict(), BusinessWebsitePatchSchema]);
// Reuse generation field definitions; extra filter limits mirror the existing
// submit_lifty_config_update RPC. Labels, weights and fingerprints stay absent.
export const TargetingValuesSchema = LocalOnboardingConfigurationSchema.shape.icp_config
  .omit({ label: true }).partial().extend({
    contact_email_status: z.string().trim().min(1).max(100).optional(),
    q_organization_domains_list: z.array(z.string().trim().min(1)).nullable().optional(),
    max_stale_days: z.number().int().min(1).max(3650).optional(),
    reject_extrapolated: z.boolean().optional(),
  }).strict();
export const TargetingStagePatchSchema = z.object({
  section: z.literal("icp"), values: TargetingValuesSchema,
  configuration: LocalConfigUpdateConfigurationSchema.optional(),
}).strict();
export const ResearchStagePatchSchema = z.object({
  section: z.literal("prompt"), instruction: z.string().trim().min(1).max(4000),
  configuration: LocalConfigUpdateConfigurationSchema.optional(),
}).strict();
export const VoiceStagePatchSchema = z.object({
  section: z.literal("tone"),
  values: z.record(z.string(), z.unknown()).describe("Free-form customer commercial voice values merged by the existing config RPC, for example identity, value_prop and cta. Not Lifty identity or campaign approval."),
  configuration: LocalConfigUpdateConfigurationSchema.optional(),
}).strict();
const ChannelCampaignQuerySchema = z.object({
  channel: z.enum(["email", "linkedin"]), workspace: z.string().min(1), campaign_ref: z.uuid(),
  operation: z.enum(["status", "preview"]).default("status"),
}).strict();
const ChannelCampaignRequestSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("email"), request: EmailCampaignRequest }).strict(),
  z.object({ channel: z.literal("linkedin"), request: LinkedinCampaignRequest }).strict(),
]);
const ChannelCampaignPatchSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("email"), request: z.intersection(EmailCampaignRequest,
    z.object({ operation: z.literal("prepare"), payload: z.object({ campaign_ref: z.uuid() }).passthrough() }).passthrough()) }).strict(),
  z.object({ channel: z.literal("linkedin"), request: z.intersection(LinkedinCampaignRequest,
    z.object({ operation: z.literal("prepare"), payload: z.object({ campaign_ref: z.uuid() }).passthrough() }).passthrough()) }).strict(),
]);

export const CampaignStageQuerySchema = z.union([
  z.object({ scope: z.literal("workspace").default("workspace"), operation: z.enum(["status", "preview"]).default("status") }).strict(),
  ChannelCampaignQuerySchema,
]);
export const CampaignStageRequestSchema = z.union([
  z.object({ scope: z.literal("workspace"), request: WorkspaceCampaignRequest }).strict(), ChannelCampaignRequestSchema,
]);
export const CampaignStagePatchSchema = z.union([
  z.object({ scope: z.literal("workspace"), request: z.union([WorkspaceCampaignModifyRequest, WorkspaceCampaignConfigureRequest, WorkspaceCampaignRequest.options[1]]) }).strict(), ChannelCampaignPatchSchema,
]);

function json(schema: z.ZodType, io: "input" | "output" = "output") {
  return z.toJSONSchema(schema, { io });
}
function operation(method: StageOperation["method"], route: string, description: string,
  response: z.ZodType | null, body: z.ZodType | null = null, query: z.ZodType = Empty,
  path: z.ZodType = Empty): StageOperation {
  return {
    method, route, description,
    request: { path: json(path, "input"), query: { type: "object", ...json(query, "input") }, body: body ? json(body, "input") : null },
    responses: response
      ? { "200": json(response), "400": json(StageErrorSchema), "401": json(StageErrorSchema),
        "403": json(StageErrorSchema), "404": json(StageErrorSchema), "413": json(StageErrorSchema), "409": json(StageErrorSchema), "422": json(StageErrorSchema),
        "429": json(StageErrorSchema), "502": json(StageErrorSchema), "503": json(StageErrorSchema), "504": json(StageErrorSchema) }
      : { "405": json(StageErrorSchema), "401": json(StageErrorSchema) },
  };
}
const stageRoute = (stage: string) => `/v1/workspace/${stage}`;
const unsupported = (stage: string, method: "POST" | "PATCH", reason: string) =>
  operation(method, stageRoute(stage), `Unsupported: ${reason} Returns 405 STAGE_OPERATION_UNSUPPORTED; no changes.`, null, Empty);
const configRead = (stage: string, description: string) =>
  operation("GET", stageRoute(stage), description, WorkspaceConfigSchema);
const configWrite = (stage: string, section: string, body: z.ZodType) =>
  operation("PATCH", stageRoute(stage), `Update only the ${section} section using the existing config validation/import. Supply section=${section}; another section is rejected. A queued receipt requires status polling and GET readback.`, ConfigUpdateResultSchema,
    body);
const initialSetup = (stage: string): StageOperation => ({ ...operation("POST", stageRoute(stage),
  "Submit the complete first onboarding configuration once, using current private generation context. Not a partial-stage replacement; an existing configuration is rejected.",
  OnboardingPushResultSchema, SubmitOnboardingRequestSchema),
  submission: {
    version: "lifty-local-submission.v1", artifact: "onboarding-configuration",
    status: { operation: "onboarding_status", input: {}, state: "/state",
      pending: ["pending"], succeeded: ["imported"], failed: ["failed"],
      match: [
        { receipt: "/submission_ref", response: "/submission_ref" },
        { receipt: "/draft_digest", response: "/draft_digest" },
        { receipt: "/workspace/workspace_ref", response: "/workspace/workspace_ref" },
      ], poll_interval_ms: 3000, timeout_ms: 60000 },
    readback: [{ operation: "get", input: {}, match: [{ receipt: "/workspace/workspace_ref", response: "/workspace_ref" }] }],
  },
});
const configSupport = {
  generation_context: operation("GET", "/v1/config/context", "Read private current configuration, generation rules and current artifact schema before an edit.", ConfigUpdateGenerationContextSchema),
  onboarding_context: operation("GET", "/v1/onboarding/context", "Read private generation rules and artifact schema before first setup.", OnboardingGenerationContextSchema),
  onboarding_status: operation("GET", "/v1/onboarding", "Read initial configuration import status before confirming setup.", OnboardingStatusSchema),
  update_status: operation("GET", "/v1/config/updates/{submission_ref}", "Read this exact update receipt. A failed read does not mean the update failed.", ConfigUpdateStatusSchema, null, Empty, z.object({ submission_ref: z.string().min(1) }).strict()),
  resolve_update: operation("POST", "/v1/config/updates/resolve", "Resolve an unchanged original generated edit including its configuration artifact after an uncertain write; direct metadata edits use GET readback and any returned receipt instead.", ConfigUpdateStatusSchema, ConfigUpdateRequestSchema),
};

// These definitions are also the contracts for the thin authenticated adapters
// implemented with the generic stage transport. Existing business handlers and
// their authorization, validation, jobs and protected-field rules remain owners.
export const stageOperations: Record<string, Record<string, StageOperation>> = {
  summary: {
    get: operation("GET", stageRoute("summary"), "Read this authenticated workspace at the start of every session. Compact existing business, website, connection and saved campaign state. Unavailable means retry, not missing setup.", WorkspaceSummarySchema),
    post: unsupported("summary", "POST", "Summary is read-only."),
    patch: unsupported("summary", "PATCH", "Summary is read-only."),
  },
  business: {
    get: operation("GET", stageRoute("business"), "Read workspace existence and saved business name/description and confirmed website with unconfirmed research candidates; configuration is null before provisioning.", BusinessStageSchema),
    post: operation("POST", stageRoute("business"), "Provision the authenticated founder's workspace using the existing create operation.", CreateWorkspaceResultSchema, CreateWorkspaceRequestSchema),
    patch: operation("PATCH", stageRoute("business"), "Update name/description with section=workspace, or the confirmed primary website with section=website and its current expected_version. Website updates are immediate; read back after uncertain writes. No campaign changes.", z.union([ConfigUpdateResultSchema, BusinessWebsiteSchema]), BusinessStagePatchSchema),
    update_status: configSupport.update_status,
  },
  targeting: { get: configRead("targeting", "Read saved ICP/personas; versions and lane allocation are read-only."), post: initialSetup("targeting"), patch: configWrite("targeting", "icp", TargetingStagePatchSchema), ...configSupport },
  "research-criteria": { get: configRead("research-criteria", "Read the saved research prompt and provenance; protected prompts remain read-only."), post: initialSetup("research-criteria"), patch: configWrite("research-criteria", "prompt", ResearchStagePatchSchema), ...configSupport },
  "sample-review": {
    progress: operation("GET", "/v1/workspace/runs/progress", "Wait up to 25 seconds for a change to this exact run. Pass the last cursor to resume. Returns the complete current bounded cohort, live research count and terminal state; not a persisted event history. Read-only and reauthorized on each poll.", RunProgressSchema, null, RunProgressQuerySchema),
    get: operation("GET", stageRoute("sample-review"), "Read the existing cohort, grades and run state; no persisted approval ledger.", RunStatusSchema),
    post: operation("POST", stageRoute("sample-review"), "Start/retrieve the existing bounded initial run; no repeated discovery waves or new approval store.", StartRunResultSchema, Empty),
    patch: unsupported("sample-review", "PATCH", "Grades, historical evidence and sample approval are not writable configuration."),
  },
  "commercial-voice": { get: configRead("commercial-voice", "Read the customer's saved commercial tone; distinct from Lifty's identity."), post: initialSetup("commercial-voice"), patch: configWrite("commercial-voice", "tone", VoiceStagePatchSchema), ...configSupport },
  crm: {
    mapping_catalog: operation("GET", "/v1/workspace/crm/mapping/catalog", "Read the current workspace's full saved mapping, supported sources/transforms/write rules and live HubSpot contact/company schema including internal enum values. This is the general mapper; mapping_context remains bounded company setup.", CrmMappingCatalogSchema),
    mapping_sources: operation("POST", "/v1/workspace/crm/mapping/sources", "Read saved discovery/research evidence for the explicitly selected leads. Person location and company headquarters are distinct; a missing source is unknown. Does not acquire or enrich leads.", CrmMappingSourcesSchema, CrmMappingSourcesRequestSchema),
    mapping_preview: operation("POST", "/v1/workspace/crm/mapping/preview", "Preview the selected lead cohort with the existing mapper against live CRM schema and record values; inspect per-field values, skipped reasons and conflicts before applying or syncing. Does not save mappings or write CRM records.", CrmMappingPreviewSchema, CrmMappingPreviewRequestSchema),
    mapping_apply: operation("POST", "/v1/workspace/crm/mapping/apply", "Save explicit validated edits to the full mapping with current portal and mapping version checks, preserving unrelated mappings. Does not sync CRM records or create properties; fetch a fresh catalog and preview afterward.", CrmMappingApplySchema, CrmMappingApplyRequestSchema),
    property_create: operation("POST", "/v1/workspace/crm/mapping/property_create", "Explicitly create a missing HubSpot property only when workspace provisioning policy permits. First inspect the live catalog for an existing compatible property. Never create a duplicate field just to bypass a mapping conflict.", CrmMappingPropertyCreateSchema, CrmMappingPropertyCreateRequestSchema),
    mapping_sync: operation("POST", "/v1/workspace/crm/mapping/sync", "Replay the saved mapping only for the explicit bounded lead cohort using the current preview digest and a stable request_ref. This queues a receipt, not verified success; poll mapping_status for this exact run. Does not discover leads or send outreach.", CrmMappingSyncSchema, CrmMappingSyncRequestSchema),
    mapping_status: operation("GET", "/v1/workspace/crm/mapping/status", "Read the exact mapping replay receipt, including per-field live readback and skipped or stale values. Report only values the receipt verifies; partial or failed runs are not full success.", CrmMappingStatusSchema, null, CrmMappingStatusQuerySchema),
    records: operation("GET", "/v1/workspace/crm/records", "Read contact and company links for the existing sync cohort. Supply the known run_ref or omit for the latest CRM sync. This never starts a sync.", CrmRecordsSchema, null, CrmRecordsQuerySchema),
    get: operation("GET", stageRoute("crm"), "Without attempt_ref read HubSpot connection state. With it verify only that exact authorization attempt, including reconnection.", z.union([HubspotConnectionStatusSchema, ConnectionAttemptStatusSchema]), null, ConnectionAttemptQuerySchema),
    post: operation("POST", stageRoute("crm"), "Start a new HubSpot connection/reconnection and return the real consent link immediately.", AuthorizationRequiredSchema, Empty),
    patch: operation("PATCH", stageRoute("crm"), "Apply the bounded company mapping plan from mapping_context. No tokens, arbitrary mappings or connected flag updates.", CompanyMappingReceiptSchema, CompanyPlanSchema),
    mapping_context: operation("GET", "/v1/workspace/crm/mapping-context", "Read the current authenticated workspace's live portal schema/mapping and its current bounded input schema.", CompanyMappingContextSchema),
  },
  "sending-accounts": {
    get: operation("GET", stageRoute("sending-accounts"), "Read the selected channel's current account, or verify the exact attempt_ref. A healthy previous account is not a new attempt's success.", z.union([EmailConnectionStatus, LinkedinConnectionStatus, ConnectionAttemptStatusSchema]), null, SendingAccountQuerySchema),
    post: operation("POST", stageRoute("sending-accounts"), "Start hosted LinkedIn or email connection/reconnection. For email, select_account: true opens provider/account selection after an explicit disconnect; omit it to reconnect the saved account.", AuthorizationRequiredSchema, SendingAccountStartSchema),
    patch: unsupported("sending-accounts", "PATCH", "Account identity, policy limits and sending enablement cannot be changed through configuration or used to bypass consent."),
  },
  campaigns: {
    get: operation("GET", stageRoute("campaigns"), "Read the saved workspace graph, composition policy, current/future audience and preparation state by default. Previews are saved recipient examples. Explicit channel plus campaign_ref reads an existing individual campaign.", z.union([WorkspaceCampaignResult, EmailCampaignResult, LinkedinCampaignResult]), null, CampaignStageQuerySchema),
    post: operation("POST", stageRoute("campaigns"), "Configure a shared_v1 campaign graph, compose modes and outreach overlays; omission of lead_ids covers current and future eligible leads. Read its ready preview, then activate the exact version/digest after informed confirmation. Configuration does not send. Legacy prepare and individual operations remain compatible.", z.union([WorkspaceCampaignResult, EmailCampaignResult, LinkedinCampaignResult]), CampaignStageRequestSchema),
    patch: operation("PATCH", stageRoute("campaigns"), "Modify only requested fields using the saved version_ref and digest. Nested channel fields merge; arrays replace; null removes a channel, audience override, start override or template_bank. Material changes pause automatic outreach and require fresh preparation and activation. Legacy prepare remains compatible.", z.union([WorkspaceCampaignResult, EmailCampaignResult, LinkedinCampaignResult]), CampaignStagePatchSchema),
  },
  notifications: {
    get: operation("GET", stageRoute("notifications"), "Read notification routes/destinations and Slack state, or verify the exact Slack attempt_ref.", z.union([NotificationConfigSchema, ConnectionAttemptStatusSchema]), null, ConnectionAttemptQuerySchema),
    post: operation("POST", stageRoute("notifications"), "Start Slack connection/reconnection and immediately return the workspace consent link.", AuthorizationRequiredSchema, Empty),
    patch: operation("PATCH", stageRoute("notifications"), "Save a supported Slack destination or notification route using existing handlers. This cannot authorize Slack or send a test.", z.union([NotificationDestinationSchema, NotificationRouteSchema]), NotificationStagePatchSchema),
    channels: operation("GET", "/v1/notifications/slack/channels", "Read Slack channels currently available to Lifty before choosing a destination.", SlackNotificationChannelsSchema),
  },
  capacity: {
    get: operation("GET", stageRoute("capacity"), "Read workspace daily discovery target and actual weekly allowance including used, reserved, remaining and reset time.", CapacityStageSchema),
    post: unsupported("capacity", "POST", "Capacity is platform-managed; there is no capacity setup operation."),
    patch: unsupported("capacity", "PATCH", "Operating target, lane weights, provider limits and allowance counters are read-only."),
  },
};
