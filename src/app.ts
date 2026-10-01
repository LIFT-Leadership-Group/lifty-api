import { RepairIssueSchema } from "./business-contracts.js";
import { executeBusinessOperation } from "./business-operations.js";
import { createConfirmationRouter, invalidConfirmation, type ConfirmationAdapters, type ConfirmationAdapter, type ConfirmationLog } from "./connection-confirmation.js";
import { RunProgressQuerySchema, RunProgressSchema, type RunProgressQuery, type RunProgress } from "./run-progress.js";
import type { WorkspaceCampaignInput, WorkspaceCampaignOutput } from "./workspace-campaign-contracts.js";
import type { CrmMappingOperation } from "./crm-mapping/contracts.js";
import { CrmMappingError } from "./crm-mapping.js";
import { registerStageRoutes } from "./stage-routes.js";
import { handleMcpRequest, mcpResourceMetadata, type McpDependencies } from "./mcp.js";
import { getStageMcpTools, callStageMcpTool } from "./mcp-stage-tools.js";
import { renderEmailAuthorizationPage, renderEmailAuthorizationReceivedPage } from "./email-authorization-page.js";
import { type ConnectionReturnResult } from "./connection-return-page.js";
import { hostedReturnError, type HostedReturnError } from "./hosted-return-error.js";
import { PENDING_SUBMIT_SCRIPT_HASH, renderLiftyPage } from "./lifty-brand.js";
import { readFileSync } from "node:fs";
import { createWarmupSetupRouter } from "./warmup-setup-routes.js";
import type { WarmupSetup } from "./warmup-setup.js";
import { versionedHostedAuthUrl, parseHostedAuthOrigin, UNIPILE_HOSTED_AUTH_ORIGIN } from "./hosted-auth-branding.js";
import { getConnectionAttempt, type ConnectionAttemptStatus, type ConnectionProvider } from "./connection-attempt.js";
import {
  type CompanyMappingOperation,
  CompanyMappingContextSchema,
  CompanyMappingReceiptSchema,
  CompanyMappingError,
} from "./company-mapping.js";
import { RetireWorkspaceRequest, RetireWorkspaceConfirmation, RetireWorkspaceResult, type RetireWorkspaceInput, type RetireWorkspaceOutput } from "./workspace-retirement.js";
import { DeleteLoginRequest, DeleteLoginResult, type DeleteLoginInput, type DeleteLoginOutput } from "./login-deletion.js";
import { MemberWorkspacesResult, type MemberWorkspacesOutput } from "./member-workspaces.js";

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { CLIENT_UPGRADE_MESSAGE, STAGE_CLIENT_CONTRACT, AgentContextSchema, getAgentContext } from "./agent-context.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DisconnectResponseSchema, IntegrationConnectionStatusSchema, NotificationConfigSchema, NotificationDestinationSchema, NotificationRouteSchema, NotificationTestResultSchema, SetNotificationRouteRequestSchema, SlackNotificationChannelsSchema, UpsertNotificationDestinationRequestSchema, ProviderConnectStartSchema, LegacyProviderConnectStartSchema, SlackConnectLinkSchema, type SlackConnectLink, ProviderSchema, RunStatusSchema, StartRunResultSchema, StartCrmSyncResultSchema, CrmSyncStatusSchema, type DisconnectResult, type HubspotConnectStart, type HubspotConnectionStatus, type NotificationConfig, type NotificationDestination, type NotificationRoute, type NotificationTestResult, type SetNotificationRouteRequest, type SlackNotificationChannels, type UpsertNotificationDestinationRequest, type Provider, type SlackConnectStart, type SlackConnectionStatus, type RunStatus, type StartRunResult, type StartCrmSyncResult, type CrmSyncStatus, WorkspaceStatusSchema, type WorkspaceStatus } from "./contracts.js";
import { type EnqueueCrmSync, type EnqueueFirstRun, type EnqueueIntegrationRevocation, type EnqueueNotificationDelivery } from "./trigger-client.js";
import { PublicError } from "./errors.js";
import {
  HubspotCallbackError,
  type HubspotCallbackSuccess,
} from "./hubspot-connect.js";
import { isSealedHubspotState } from "./hubspot-state.js";
import {
  SlackCallbackError,
  type SlackCallbackSuccess,
} from "./slack-connect.js";
import { isSealedSlackState } from "./slack-state.js";

import { LinkedinCampaignRequest, LinkedinCampaignResult, linkedinCampaignResultFor, type LinkedinCampaignInput, type LinkedinCampaignOutput } from "./linkedin-campaign-contracts.js";
import { LinkedinConnectRequest, LinkedinConnectResult, LegacyLinkedinConnectResult, LinkedinConnectionStatus, LinkedinWorkspaceRequest, LinkedinDisconnectRequest, type LinkedinConnectInput, type LinkedinStart, type LinkedinStatus } from "./linkedin-contracts.js";
import { EmailCampaignRequest, EmailCampaignResult, EmailPlacementResult, EmailPlacementPreview, campaignResultFor, type EmailCampaignInput, type EmailCampaignOutput } from "./email-campaign-contracts.js";
import { HostedEmailProvider, EmailConnectRequest, EmailConnectResult, LegacyEmailConnectResult, EmailConnectionStatus, type EmailConnectInput, type EmailStart, type EmailStatus } from "./email-contracts.js";
import { WarmupStartResult, WarmupStatus, WarmupWorkspaceRequest, type WarmupStartResult as WarmupStart, type WarmupStatus as WarmupStatusValue } from "./email-warmup-contracts.js";
import { ConnectionPlacementStatus, PlacementStartRequest, PlacementStatusRequest, type PlacementStartInput, type PlacementStatusInput } from "./email-connection-placement.js";
import { DeliverabilityQuery, DeliverabilityQueryParams, DeliverabilityResponse, type DeliverabilityQuery as DeliverabilityQueryValue, type DeliverabilityResponse as DeliverabilityResponseValue } from "./email-deliverability-contracts.js";
import { EmailAccountsRequest, EmailAccountsResult, EmailAccountConnectRequest, EmailAccountConnectResult,
  EmailAccountStatusRequest, EmailAccountStatusResult, type EmailAccountsInput, type EmailAccountsOutput,
  type EmailAccountConnectInput, type EmailAccountConnectOutput, type EmailAccountStatusInput, type EmailAccountStatusOutput } from "./email-accounts-contracts.js";

const MAX_REQUEST_BYTES = 132 * 1024;
// The create-workspace body carries only a bounded name and description.
const MAX_CREATE_WORKSPACE_BYTES = 16 * 1024;
const RequestIdSchema = z.uuid();
const SubmissionRefSchema = z.uuid();
const DestinationRefSchema = z.uuid();

export interface AuthSession {
  userId: string;
  client: unknown;
}

export type AuthenticationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "invalid_session" };

export type { WorkspaceStatus } from "./contracts.js";

export interface AppDependencies {
  openAiAppsChallenge?: string;
  mcp?: McpDependencies;
  renderOAuthConsentPage?(authorizationId: string): { html: string; scriptNonce: string; connectOrigin: string };
  warmupSetup?: WarmupSetup;
  unipileHostedAuthOrigin: string;
  unipileV2HostedAuthOrigins: string[];
  receiveEmailV2Return: (state:string,returnError:HostedReturnError|null)=>Promise<ConnectionReturnResult|void>;
  receiveLinkedinV2Return: (state:string,returnError:HostedReturnError|null)=>Promise<ConnectionReturnResult|void>;
  receiveClientEmailV2Return: (state:string,returnError:HostedReturnError|null)=>Promise<ConnectionReturnResult|void>;
  authorizeClientEmail: (state:string)=>Promise<string>;
  getConnectionAttempt(session: AuthSession, provider: ConnectionProvider, attemptRef: string, workspace: string): Promise<ConnectionAttemptStatus>;
  retireWorkspace(session: AuthSession, input: RetireWorkspaceInput): Promise<RetireWorkspaceOutput>;
  deleteOwnLogin(session: AuthSession, input: DeleteLoginInput): Promise<DeleteLoginOutput>;
  emailCampaign(session: AuthSession, input: EmailCampaignInput): Promise<EmailCampaignOutput>;
  workspaceCampaign(session: AuthSession, input: WorkspaceCampaignInput): Promise<WorkspaceCampaignOutput>;
  linkedinCampaign(session: AuthSession, input: LinkedinCampaignInput): Promise<LinkedinCampaignOutput>;
  startLinkedinConnect(session: AuthSession, input: LinkedinConnectInput): Promise<LinkedinStart>;
  getLinkedinConnection(session: AuthSession, workspace: string, attemptRef?: string): Promise<LinkedinStatus>;
  disconnectLinkedin(session: AuthSession, workspace: string): Promise<LinkedinStatus>;
  authorizeLinkedin(state: string): Promise<string>;
  completeLinkedinCallback(state: string, body: unknown): Promise<void>;
  emailAvailable: boolean;
  emailAuthorizationOrigin: string | null;
  startEmailConnect(session: AuthSession, input: EmailConnectInput): Promise<EmailStart>;
  getEmailConnection(session: AuthSession, workspace: string, attemptRef?: string): Promise<EmailStatus>;
  disconnectEmail(session: AuthSession, workspace: string): Promise<EmailStatus>;
  authorizeEmail(state: string): Promise<string>;
  declareEmail(state: string, provider?: HostedEmailProvider, mailboxUse?: "personal" | "outreach"): Promise<string>;
  getEmailWarmup(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStatusValue>;
  startEmailWarmup(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStart>;
  changeEmailWarmup(session: AuthSession, workspace: string, operation: "pause" | "resume" | "remove", connectionRef?: string): Promise<WarmupStatusValue>;
  getEmailDeliverability(session: AuthSession, query: DeliverabilityQueryValue): Promise<DeliverabilityResponseValue>;
  getEmailPlacement(session: AuthSession, input: PlacementStatusInput): Promise<ConnectionPlacementStatus>;
  startEmailPlacement(session: AuthSession, input: PlacementStartInput): Promise<ConnectionPlacementStatus>;
  getEmailAccounts(session:AuthSession,input:EmailAccountsInput):Promise<EmailAccountsOutput>;
  connectEmailAccount(session:AuthSession,input:EmailAccountConnectInput):Promise<EmailAccountConnectOutput>;
  getEmailAccountAttempt(session:AuthSession,input:EmailAccountStatusInput):Promise<EmailAccountStatusOutput>;
  completeEmailCallback(state: string, body: unknown): Promise<void>;
  authenticate(request: Request): Promise<AuthenticationResult>;
  businessOperation(session: AuthSession, key: string, workspaceRef: string | null, payload?: unknown): Promise<unknown>;
  getWorkspace(session: AuthSession): Promise<WorkspaceStatus>;
  listMemberWorkspaces(session: AuthSession): Promise<MemberWorkspacesOutput>;
  startRun(session: AuthSession): Promise<StartRunResult>;
  getRunStatus(session: AuthSession): Promise<RunStatus>;
  getRunProgress(session: AuthSession, query: RunProgressQuery, signal: AbortSignal): Promise<RunProgress>;
  enqueueFirstRun: EnqueueFirstRun;
  startCrmSyncRun(session: AuthSession): Promise<StartCrmSyncResult>;
  getCrmSyncStatus(session: AuthSession): Promise<CrmSyncStatus>;
  runCrmMapping: CrmMappingOperation;
  enqueueCrmSync: EnqueueCrmSync;
  disconnectIntegration(session: AuthSession, provider: Provider): Promise<DisconnectResult>;
  enqueueIntegrationRevocation: EnqueueIntegrationRevocation;
  getNotificationConfig(session: AuthSession): Promise<NotificationConfig>;
  companyMapping: CompanyMappingOperation;
  listSlackNotificationChannels(session: AuthSession): Promise<SlackNotificationChannels>;
  upsertNotificationDestination(
    session: AuthSession,
    input: UpsertNotificationDestinationRequest,
  ): Promise<NotificationDestination>;
  setNotificationRoute(
    session: AuthSession,
    input: SetNotificationRouteRequest,
  ): Promise<NotificationRoute>;
  enqueueNotificationTest(
    session: AuthSession,
    destinationRef: string,
  ): Promise<NotificationTestResult>;
  enqueueNotificationDelivery: EnqueueNotificationDelivery;
  startHubspotConnect(session: AuthSession): Promise<HubspotConnectStart>;
  getHubspotConnection(session: AuthSession): Promise<HubspotConnectionStatus>;
  completeHubspotCallback(
    input: { code: string; state: string },
  ): Promise<HubspotCallbackSuccess>;
  denyHubspotCallback(state: string): Promise<void>;
  buildHubspotAuthorizeUrl(state: string): string | null;
  startSlackConnect(session: AuthSession): Promise<SlackConnectStart>;
  createSlackConnectLink(session: AuthSession, workspaceId: string): Promise<SlackConnectLink>;
  getSlackConnection(session: AuthSession): Promise<SlackConnectionStatus>;
  completeSlackCallback(
    input: { code: string; state: string },
  ): Promise<SlackCallbackSuccess>;
  denySlackCallback(state: string): Promise<void>;
  buildSlackAuthorizeUrl(state: string): string | null;
  renderCliAuthPage(
    state: string,
    port: number,
  ): {
    html: string;
    scriptNonce: string;
    connectOrigin?: string;
  } | null;
  renderPasswordRecoveryPage(page: "request" | "update"): {
    html: string; scriptNonce: string; connectOrigin: string;
  } | null;
  checkReadiness(): Promise<boolean>;
  checkCompanyReadiness(): Promise<boolean>;
  checkCrmMappingReadiness(): Promise<boolean>;
  connectionCallbacks?: ConfirmationAdapters;
  validateConnectionReturn?(flow:"email"|"linkedin"|"client-email", state:string):void;
  log(event: LogEvent): void;
}

export interface LogEvent {
  level: "warn" | "error";
  event: "request_failed" | "revocation_enqueue_failed" | "connection_confirmation";
  request_id: string;
  method: string;
  path: string;
  error_code: string;
  status: number;
  stage?: string;
  elapsed_ms?: number;
  upstream_operation?: string;
  upstream_code?: string;
  upstream_kind?: string;
  provider_error?: string;
}

export type AppEnvironment = {
  Variables: {
    requestId: string;
    requestStartedAt: number;
    operationStage?: string;
    authSession: AuthSession;
  };
};

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(RepairIssueSchema).max(20).optional(),
  }),
  request_id: z.string(),
});

const JsonResponse = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
  description: "JSON response",
});

const ProviderPathParams = z.object({
  provider: ProviderSchema.openapi({ param: { name: "provider", in: "path" } }),
});

async function readRequestTextWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        parts.push(decoder.decode());
        return { ok: true, text: parts.join("") };
      }

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response remains 413 even when the upstream stream cannot cancel.
        }
        return { ok: false };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function registerOpenApi(app: OpenAPIHono<AppEnvironment>): void {
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/workspaces/{workspace_ref}/retire",operationId:"retireWorkspace",security:[{bearerAuth:[]}],
    request:{params:z.object({workspace_ref:z.uuid()}),body:{required:true,content:{"application/json":{schema:RetireWorkspaceConfirmation}}}},
    responses:{200:JsonResponse(RetireWorkspaceResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/me/workspaces",operationId:"listMemberWorkspaces",security:[{bearerAuth:[]}],
    responses:{200:JsonResponse(MemberWorkspacesResult),401:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/me/delete",operationId:"deleteOwnLogin",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:DeleteLoginRequest}}}},
    responses:{200:JsonResponse(DeleteLoginResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),404:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({ method: "post", path: "/v1/linkedin/connect", operationId: "startLinkedinConnect", security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { "application/json": { schema: LinkedinConnectRequest } } } },
    responses: { 200: JsonResponse(LegacyLinkedinConnectResult), 400: JsonResponse(ErrorResponseSchema), 401: JsonResponse(ErrorResponseSchema), 403: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema), 429: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema), 503: JsonResponse(ErrorResponseSchema) } });
  app.openAPIRegistry.registerPath({ method: "get", path: "/v1/linkedin", operationId: "getLinkedinConnection", security: [{ bearerAuth: [] }],
    request: { query: LinkedinWorkspaceRequest },
    responses: { 200: JsonResponse(LinkedinConnectionStatus), 400: JsonResponse(ErrorResponseSchema), 401: JsonResponse(ErrorResponseSchema), 403: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema), 503: JsonResponse(ErrorResponseSchema) } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/v1/linkedin/disconnect", operationId: "disconnectLinkedin", security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { "application/json": { schema: LinkedinDisconnectRequest } } } },
    responses: { 200: JsonResponse(LinkedinConnectionStatus), 400: JsonResponse(ErrorResponseSchema), 401: JsonResponse(ErrorResponseSchema), 403: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema), 503: JsonResponse(ErrorResponseSchema) } });
  app.openAPIRegistry.registerPath({ method: "post", path: "/v1/linkedin/campaign", operationId: "linkedinCampaign", security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { "application/json": { schema: LinkedinCampaignRequest } } } },
    responses: { 200: JsonResponse(LinkedinCampaignResult), 400: JsonResponse(ErrorResponseSchema), 401: JsonResponse(ErrorResponseSchema), 403: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema), 503: JsonResponse(ErrorResponseSchema) } });
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/campaign/placement/preview",operationId:"previewEmailPlacement",security:[{bearerAuth:[]}],
    request:{query:z.object({workspace:EmailConnectRequest.shape.workspace,campaign_ref:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)})},
    responses:{200:JsonResponse(EmailPlacementPreview),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/campaign/placement",operationId:"getEmailPlacement",security:[{bearerAuth:[]}],
    request:{query:z.object({workspace:EmailConnectRequest.shape.workspace,campaign_ref:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)})},
    responses:{200:JsonResponse(EmailPlacementResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/campaign",operationId:"emailCampaign",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:EmailCampaignRequest}}}},
    responses:{200:JsonResponse(EmailCampaignResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/disconnect",operationId:"disconnectEmail",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:z.object({workspace:EmailConnectRequest.shape.workspace}).strict()}}}},
    responses:{200:JsonResponse(EmailConnectionStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/connect",operationId:"startEmailConnect",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:EmailConnectRequest}}}},
    responses:{200:JsonResponse(LegacyEmailConnectResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/warmup",operationId:"getEmailWarmup",security:[{bearerAuth:[]}],
    request:{query:WarmupWorkspaceRequest},responses:{200:JsonResponse(WarmupStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/deliverability",operationId:"getEmailDeliverability",security:[{bearerAuth:[]}],
    description:"Read-only inbox health shared by the Deliverability page and the Lifty CLI: inboxes, warmup, placement history, campaigns, approval, notes and explained states (email-deliverability.v1). Never creates tests or changes sending.",
    request:{query:DeliverabilityQueryParams},responses:{200:JsonResponse(DeliverabilityResponse),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),404:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/placement",operationId:"getEmailPlacement",security:[{bearerAuth:[]}],
    description:"LIF-1063: the latest Mailivery placement test for one warmed mailbox, whether a new one can be requested, and whether its result gates sending. Read-only.",
    request:{query:PlacementStatusRequest},responses:{200:JsonResponse(ConnectionPlacementStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/placement/start",operationId:"startEmailPlacement",security:[{bearerAuth:[]}],
    description:"LIF-1063: queue one Mailivery connected-mailbox placement test after explicit consent. Mailivery sends the email from the warmed mailbox to its seed inboxes and uses one test credit. A retried start returns the open test. Never releases a mailbox.",
    request:{body:{required:true,content:{"application/json":{schema:PlacementStartRequest}}}},
    responses:{200:JsonResponse(ConnectionPlacementStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),413:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/accounts",operationId:"getEmailAccounts",security:[{bearerAuth:[]}],
    request:{query:EmailAccountsRequest},responses:{200:JsonResponse(EmailAccountsResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  for (const [path,operationId,request,response] of [
    ["/v1/email/accounts/connect","connectEmailAccount",EmailAccountConnectRequest,EmailAccountConnectResult],
    ["/v1/email/accounts/connect/status","getEmailAccountAttempt",EmailAccountStatusRequest,EmailAccountStatusResult],
  ] as const) {
    app.openAPIRegistry.registerPath({method:"post",path,operationId,security:[{bearerAuth:[]}],
      request:{body:{required:true,content:{"application/json":{schema:request}}}},
      responses:{200:JsonResponse(response),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),413:JsonResponse(ErrorResponseSchema),429:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  }
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/warmup/start",operationId:"startEmailWarmup",security:[{bearerAuth:[]}],
    description:"Start setup for the workspace's verified mailbox. OAuth-enabled servers return a one-hour Lifty setup link. Legacy servers return a signed Mailivery form link. An already-bound mailbox receives no new connection link.",
    request:{body:{required:true,content:{"application/json":{schema:WarmupWorkspaceRequest}}}},
    responses:{200:JsonResponse(WarmupStartResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),429:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  for (const operation of ["pause","resume","remove"] as const) {
    app.openAPIRegistry.registerPath({method:"post",path:`/v1/email/warmup/${operation}`,operationId:`${operation}EmailWarmup`,security:[{bearerAuth:[]}],
      request:{body:{required:true,content:{"application/json":{schema:WarmupWorkspaceRequest}}}},
      responses:{200:JsonResponse(WarmupStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  }
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email",operationId:"getEmailConnection",security:[{bearerAuth:[]}],
    request:{query:z.object({workspace:EmailConnectRequest.shape.workspace})},responses:{200:JsonResponse(EmailConnectionStatus),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspaces/{workspace_ref}/integrations/slack/connect-link",
    operationId: "createAdminSlackConnectLink",
    description: "Create a single-use, seven-day client invitation. Requires membership in the selected active workspace.",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ workspace_ref: z.uuid().openapi({ param: { name: "workspace_ref", in: "path" } }) }) },
    responses: {
      200: JsonResponse(SlackConnectLinkSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    responses: { 200: JsonResponse(z.object({ status: z.literal("ok") })) },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/readyz",
    operationId: "getReadiness",
    responses: {
      200: JsonResponse(z.object({ status: z.literal("ready") })),
      503: JsonResponse(z.object({ status: z.literal("unready") })),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/workspace",
    operationId: "getWorkspaceStatus",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(WorkspaceStatusSchema),
      401: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspace/runs",
    operationId: "startRun",
    security: [{ bearerAuth: [] }],
    request: { headers: z.object({ "x-lifty-client-contract": z.literal(STAGE_CLIENT_CONTRACT) }) },
    responses: {
      200: JsonResponse(StartRunResultSchema),
      401: JsonResponse(ErrorResponseSchema),
      429: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/workspace/runs",
    operationId: "getRunStatus",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(RunStatusSchema),
      401: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/{provider}/sync",
    operationId: "startCrmSync",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(StartCrmSyncResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/{provider}/sync",
    operationId: "getCrmSyncStatus",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(CrmSyncStatusSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/{provider}/connect",
    operationId: "startProviderConnect",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(LegacyProviderConnectStartSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/{provider}",
    operationId: "getProviderConnection",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(IntegrationConnectionStatusSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "delete",
    path: "/v1/integrations/{provider}",
    operationId: "disconnectProvider",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(DisconnectResponseSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/notifications",
    operationId: "getNotificationConfig",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(NotificationConfigSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/hubspot/company-mapping/context",
    operationId: "getCompanyMappingContext",
    request: { query: z.object({ workspace_ref: z.uuid().optional() }) },
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(CompanyMappingContextSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
      504: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/hubspot/company-mapping",
    operationId: "applyCompanyMapping",
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    },
    responses: {
      200: JsonResponse(CompanyMappingReceiptSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
      504: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/notifications/slack/channels",
    operationId: "listSlackNotificationChannels",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(SlackNotificationChannelsSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/notifications/destinations/slack",
    operationId: "upsertSlackNotificationDestination",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: UpsertNotificationDestinationRequestSchema },
        },
      },
    },
    responses: {
      200: JsonResponse(NotificationDestinationSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/notifications/routes",
    operationId: "setNotificationRoute",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: SetNotificationRouteRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(NotificationRouteSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      404: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/notifications/destinations/{destination_ref}/test",
    operationId: "sendNotificationTest",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        destination_ref: DestinationRefSchema.openapi({
          param: { name: "destination_ref", in: "path" },
        }),
      }),
    },
    responses: {
      200: JsonResponse(NotificationTestResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
}

function hubspotPage(title: string, message: string, success: boolean): string {
  const iconPath = success
    ? "M5 13l4 4L19 7"
    : "M6 6l12 12M18 6L6 18";
  return renderLiftyPage({
    title,
    content: `<div class="symbol${success ? "" : " error"}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath}"></path></svg></div>
<h1>${title}</h1>
<p class="intro">${message}</p>
<p class="reassurance">You can close this tab.</p>`,
  });
}

function hubspotHtmlResponse(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  title: string,
  message: string,
): Response {
  return context.html(hubspotPage(title, message, status < 400), status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function errorJson(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  issues?: z.infer<typeof RepairIssueSchema>[],
): Response {
  return context.json(
    { error: { code, message, ...(issues ? { issues } : {}) }, request_id: context.get("requestId") },
    status,
  );
}

/** Provider allowlist for `/v1/integrations/{provider}/*`; `ok: false` already carries the 400. */
function resolveProvider(
  context: Context<AppEnvironment>,
): { ok: true; provider: Provider } | { ok: false; response: Response } {
  const parsed = ProviderSchema.safeParse(
    (context.req.param("provider") ?? "").toLowerCase(),
  );
  if (!parsed.success) {
    return {
      ok: false,
      response: errorJson(
        context,
        400,
        "PROVIDER_INVALID",
        "Unknown provider. Supported providers: hubspot, slack, unipile.",
      ),
    };
  }
  return { ok: true, provider: parsed.data };
}

function providerUnavailable(context: Context<AppEnvironment>, provider: Provider): Response {
  return errorJson(
    context,
    501,
    "PROVIDER_NOT_AVAILABLE",
    `Connecting ${provider} is not available yet.`,
  );
}

const defaultDependencies: AppDependencies = {
  getConnectionAttempt,
  declareEmail: async () => { throw new PublicError({ status: 503, code: "EMAIL_NOT_CONFIGURED", message: "Email connection is not configured yet." }); },
  getEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet." }); },
  startEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." }); },
  changeEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." }); },
  getEmailDeliverability: async () => { throw new PublicError({ status: 503, code: "DELIVERABILITY_NOT_CONFIGURED", message: "Deliverability is not available on this LIFTY server yet." }); },
  getEmailPlacement: async () => { throw new PublicError({ status: 503, code: "EMAIL_PLACEMENT_NOT_CONFIGURED", message: "Placement tests are not available on this LIFTY server yet." }); },
  startEmailPlacement: async () => { throw new PublicError({ status: 503, code: "EMAIL_PLACEMENT_NOT_CONFIGURED", message: "Placement tests are not available on this LIFTY server yet. Nothing was requested." }); },
  getEmailAccounts: async () => { throw new PublicError({status:503,code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:"Email account management is not available yet."}); },
  connectEmailAccount: async () => { throw new PublicError({status:503,code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:"Email account management is not available yet. Nothing was changed."}); },
  getEmailAccountAttempt: async () => { throw new PublicError({status:503,code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:"Email account setup could not be verified. Keep the same attempt reference."}); },
  denyHubspotCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  denySlackCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  retireWorkspace: async () => { throw new PublicError({status:503,code:"WORKSPACE_RETIREMENT_UNAVAILABLE",message:"Workspace retirement is not configured yet."}); },
  deleteOwnLogin: async () => { throw new PublicError({status:503,code:"LOGIN_DELETION_UNAVAILABLE",message:"Login deletion is not configured yet."}); },
  workspaceCampaign: async () => { throw new PublicError({ status: 503, code: "WORKSPACE_CAMPAIGN_NOT_CONFIGURED", message: "Workspace sequences are not configured yet." }); },
  linkedinCampaign: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn campaigns are not configured yet." }); },
  startLinkedinConnect: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  getLinkedinConnection: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  disconnectLinkedin: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  authorizeLinkedin: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  completeLinkedinCallback: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  emailCampaign: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email campaigns are not configured yet."}); },
  disconnectEmail: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  emailAvailable: false,
  unipileHostedAuthOrigin: UNIPILE_HOSTED_AUTH_ORIGIN,
  unipileV2HostedAuthOrigins: [],
  receiveEmailV2Return: async()=>{throw new PublicError({status:503,code:"INTEGRATION_NOT_CONFIGURED",message:"Connection service is unavailable."});},
  receiveLinkedinV2Return: async()=>{throw new PublicError({status:503,code:"INTEGRATION_NOT_CONFIGURED",message:"Connection service is unavailable."});},
  receiveClientEmailV2Return: async()=>{throw new PublicError({status:503,code:"INTEGRATION_NOT_CONFIGURED",message:"Connection service is unavailable."});},
  authorizeClientEmail: async()=>{throw new PublicError({status:503,code:"INTEGRATION_NOT_CONFIGURED",message:"Connection service is unavailable."});},
  emailAuthorizationOrigin: null,
  startEmailConnect: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  getEmailConnection: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  authorizeEmail: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  completeEmailCallback: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  authenticate: async () => ({ ok: false, reason: "invalid_session" }),
  businessOperation: executeBusinessOperation,
  getWorkspace: async () => {
    throw new Error("getWorkspace is not configured");
  },
  listMemberWorkspaces: async () => { throw new PublicError({status:503,code:"WORKSPACES_UNAVAILABLE",message:"Workspace listing is not configured yet."}); },
  startRun: async () => {
    throw new Error("startRun is not configured");
  },
  getRunProgress: async () => { throw new Error("getRunProgress is not configured"); },
  getRunStatus: async () => {
    throw new Error("getRunStatus is not configured");
  },
  enqueueFirstRun: async () => {
    throw new Error("enqueueFirstRun is not configured");
  },
  startCrmSyncRun: async () => {
    throw new Error("startCrmSyncRun is not configured");
  },
  runCrmMapping: async () => { throw new PublicError({ status: 503, code: "CRM_MAPPING_NOT_CONFIGURED", message: "CRM mapping is not configured." }); },
  getCrmSyncStatus: async () => {
    throw new Error("getCrmSyncStatus is not configured");
  },
  enqueueCrmSync: async () => {
    throw new Error("enqueueCrmSync is not configured");
  },
  disconnectIntegration: async () => {
    throw new Error("disconnectIntegration is not configured");
  },
  enqueueIntegrationRevocation: async () => {
    throw new Error("enqueueIntegrationRevocation is not configured");
  },
  getNotificationConfig: async () => {
    throw new Error("getNotificationConfig is not configured");
  },
  companyMapping: async () => {
    throw new Error("companyMapping is not configured");
  },
  listSlackNotificationChannels: async () => {
    throw new Error("listSlackNotificationChannels is not configured");
  },
  upsertNotificationDestination: async () => {
    throw new Error("upsertNotificationDestination is not configured");
  },
  setNotificationRoute: async () => {
    throw new Error("setNotificationRoute is not configured");
  },
  enqueueNotificationTest: async () => {
    throw new Error("enqueueNotificationTest is not configured");
  },
  enqueueNotificationDelivery: async () => {
    throw new Error("enqueueNotificationDelivery is not configured");
  },
  startHubspotConnect: async () => {
    throw new Error("startHubspotConnect is not configured");
  },
  getHubspotConnection: async () => {
    throw new Error("getHubspotConnection is not configured");
  },
  completeHubspotCallback: async () => {
    throw new HubspotCallbackError(
      "server_misconfigured",
      503,
      "The HubSpot connection service is not configured.",
    );
  },
  buildHubspotAuthorizeUrl: () => null,
  createSlackConnectLink: async () => { throw new Error("createSlackConnectLink is not configured"); },
  startSlackConnect: async () => {
    throw new Error("startSlackConnect is not configured");
  },
  getSlackConnection: async () => {
    throw new Error("getSlackConnection is not configured");
  },
  completeSlackCallback: async () => {
    throw new SlackCallbackError(
      "server_misconfigured",
      503,
      "The Slack connection service is not configured.",
    );
  },
  buildSlackAuthorizeUrl: () => null,
  renderCliAuthPage: () => null,
  renderPasswordRecoveryPage: () => null,
  checkReadiness: async () => true,
  checkCompanyReadiness: async () => false,
  checkCrmMappingReadiness: async () => false,
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
};

export function createApp(
  overrides: Partial<AppDependencies> = {},
): OpenAPIHono<AppEnvironment> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const trustedMcpRequests = new WeakMap<Request, AuthSession>();
  const hostedAuthOrigin = parseHostedAuthOrigin(dependencies.unipileHostedAuthOrigin);
  const v2HostedAuthOrigins=dependencies.unipileV2HostedAuthOrigins.map(origin=>parseHostedAuthOrigin(origin));
  if(v2HostedAuthOrigins.includes(UNIPILE_HOSTED_AUTH_ORIGIN))throw new Error("V2 hosted origins cannot include V1.");
  const emailAuthorizationCsp = `default-src 'none'; style-src 'unsafe-inline'; script-src '${PENDING_SUBMIT_SCRIPT_HASH}'; form-action 'self' ${[hostedAuthOrigin,...v2HostedAuthOrigins].join(" ")}; base-uri 'none'; frame-ancestors 'none'`;
  const app = new OpenAPIHono<AppEnvironment>();
  registerOpenApi(app);
  const mutationWindows = new Map<string, { count: number; resetsAt: number }>();
  const favicon = readFileSync(new URL("./favicon.ico", import.meta.url));

  app.use("*", async (context, next) => {
    const suppliedRequestId = RequestIdSchema.safeParse(
      context.req.header("x-request-id"),
    );
    const requestId = suppliedRequestId.success
      ? suppliedRequestId.data
      : crypto.randomUUID();
    context.set("requestId", requestId);
    context.set("requestStartedAt", Date.now());
    context.header("x-request-id", requestId);
    await next();
  });

  const logConfirmation=(event:ConfirmationLog)=>dependencies.log({level:"warn",event:"connection_confirmation",request_id:event.correlation,method:"POST",
    path:`connection/${event.flow}`,error_code:event.outcome,status:event.status,stage:event.stage,elapsed_ms:event.elapsed_ms,
    ...(event.upstream_status===undefined?{}:{upstream_code:String(event.upstream_status)}),...(event.upstream_outcome?{upstream_kind:event.upstream_outcome}:{}),...(event.provider_error?{provider_error:event.provider_error}:{})});
  if (dependencies.warmupSetup) app.route("/warmup", createWarmupSetupRouter(dependencies.warmupSetup,logConfirmation));
  app.get("/favicon.ico", (context) => context.body(new Uint8Array(favicon).buffer, 200, {
    "content-type": "image/x-icon",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  }));
  if (dependencies.openAiAppsChallenge) {
    app.get("/.well-known/openai-apps-challenge", context => context.text(dependencies.openAiAppsChallenge!, 200, { "cache-control": "no-store" }));
  }
  if (dependencies.mcp) {
    const mcp = dependencies.mcp;
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      app.get(path, context => context.json(mcpResourceMetadata(mcp), 200, { "cache-control": "no-store" }));
    }
    app.all("/mcp", context => handleMcpRequest(context.req.raw, mcp, {
      tools: getStageMcpTools(),
      call: (name, args, request, session) => callStageMcpTool(name, args, request, (route, init) => {
        const internal = new Request(new URL(route, request.url), init); trustedMcpRequests.set(internal, session);
        return Promise.resolve(app.fetch(internal));
      }),
      workspaces: session => dependencies.listMemberWorkspaces(session),
    }));
    app.get("/oauth/consent", context => {
      const authorizationId = context.req.query("authorization_id") ?? "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(authorizationId)) {
        return hubspotHtmlResponse(context, 400, "Invalid authorization link", "Connect Lifty again to get a fresh link.");
      }
      const page = dependencies.renderOAuthConsentPage?.(authorizationId);
      if (!page || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
        || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin)) {
        return hubspotHtmlResponse(context, 503, "Sign-in unavailable", "Try connecting Lifty again in a moment.");
      }
      return context.html(page.html, 200, {
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": ["default-src 'none'", `script-src 'nonce-${page.scriptNonce}'`,
          "style-src 'unsafe-inline'", "img-src 'self'", `connect-src ${page.connectOrigin}`, "base-uri 'none'",
          "form-action 'none'", "frame-ancestors 'none'"].join("; "),
      });
    });
  }
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz/crm", async (context) => {
    let ready = false;
    try { ready = await dependencies.checkCompanyReadiness(); } catch { /* bounded health response */ }
    return context.json({ status: ready ? "ready" : "not_ready", capability: "lifty-crm-company.v1" }, ready ? 200 : 503);
  });
  app.get("/readyz/crm-mapping", async (context) => {
    let ready = false;
    try { ready = await dependencies.checkCrmMappingReadiness(); } catch { /* bounded health response */ }
    return context.json({ status: ready ? "ready" : "not_ready", capability: "lifty-crm-mapping.v1" }, ready ? 200 : 503);
  });
  app.get("/readyz", async (context) => {
    let ready: boolean;
    try {
      ready = await dependencies.checkReadiness();
    } catch {
      ready = false;
    }
    return ready
      ? context.json({ status: "ready" })
      : context.json({ status: "unready" }, 503);
  });
  for (const [route, mode] of [["/auth/password-reset", "request"], ["/auth/password-update", "update"]] as const) {
    app.get(route, (context) => {
      const page = dependencies.renderPasswordRecoveryPage(mode);
      if (!page || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
        || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin)) {
        return hubspotHtmlResponse(context, 503, "Password recovery unavailable", "Try again in a moment.");
      }
      return context.html(page.html, 200, {
        "cache-control": "no-store",
        "content-security-policy": ["default-src 'none'", `script-src 'nonce-${page.scriptNonce}'`,
          "style-src 'unsafe-inline'", `connect-src ${page.connectOrigin}`, "base-uri 'none'",
          "form-action 'none'", "frame-ancestors 'none'"].join("; "),
        "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      });
    });
  }
  app.get("/cli/auth", (context) => {
    const state = context.req.query("state") ?? "";
    const portValue = context.req.query("port") ?? "";
    const port = Number(portValue);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state)
      || !/^\d{4,5}$/.test(portValue)
      || !Number.isInteger(port)
      || port < 1024
      || port > 65535
    ) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid CLI authorization link",
        "Run lifty login again to get a fresh link.",
      );
    }
    const page = dependencies.renderCliAuthPage(state, port);
    if (
      !page
      || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
      || (page.connectOrigin !== undefined
        && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin))
    ) {
      return hubspotHtmlResponse(
        context,
        503,
        "CLI authorization unavailable",
        "Try lifty login again in a moment.",
      );
    }
    const connectSources = page.connectOrigin
      ? `${page.connectOrigin} http://127.0.0.1:${port}`
      : `http://127.0.0.1:${port}`;
    return context.html(page.html, 200, {
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${page.scriptNonce}'`,
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        `connect-src ${connectSources}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });
  app.get("/hubspot/start", (context) => {
    const intent = context.req.query("intent") ?? "";
    if (!isSealedHubspotState(intent)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid connection link",
        "Ask LIFTY for a fresh HubSpot connection link.",
      );
    }
    const authorizeUrl = dependencies.buildHubspotAuthorizeUrl(intent);
    if (!authorizeUrl) {
      return hubspotHtmlResponse(
        context,
        503,
        "Connection unavailable",
        "The HubSpot connection service is temporarily unavailable.",
      );
    }
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(authorizeUrl, 302);
  });
  app.get("/slack/start", (context) => {
    const intent = context.req.query("intent") ?? "";
    if (!isSealedSlackState(intent)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid connection link",
        "Ask LIFTY for a fresh Slack connection link.",
      );
    }
    const authorizeUrl = dependencies.buildSlackAuthorizeUrl(intent);
    if (!authorizeUrl) {
      return hubspotHtmlResponse(
        context,
        503,
        "Connection unavailable",
        "The Slack connection service is temporarily unavailable.",
      );
    }
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(authorizeUrl, 302);
  });
  for(const flow of ["hubspot","slack","email","linkedin","client-email"] as const) {
    const receive=flow==="client-email" ? dependencies.receiveClientEmailV2Return : flow==="linkedin" ? dependencies.receiveLinkedinV2Return : dependencies.receiveEmailV2Return;
    const adapter:ConfirmationAdapter=dependencies.connectionCallbacks?.[flow] ?? (flow==="hubspot" || flow==="slack" ? {
      validate(input:{state:string}) { if(!(flow==="hubspot"?isSealedHubspotState:isSealedSlackState)(input.state))throw new SyntaxError("invalid_state"); },
      status:async()=>invalidConfirmation(),
    } : {
      validate(input:{state:string}) { if(dependencies.validateConnectionReturn)dependencies.validateConnectionReturn(flow,input.state); },
      status:async(input:{state:string;errorType?:string})=>(await receive(input.state,hostedReturnError(input.errorType??"")))??{status:"pending" as const},
    });
    app.route("/",createConfirmationRouter(flow,adapter,{
      ...((adapter.origin??dependencies.emailAuthorizationOrigin) ? {origin:(adapter.origin??dependencies.emailAuthorizationOrigin)!} : {}),
      log:logConfirmation,
    }));
  }
  app.get("/unipile/client-email/start",async context=>{
    context.header("cache-control","no-store");
    context.header("referrer-policy","no-referrer");
    const target=await dependencies.authorizeClientEmail(context.req.query("intent") ?? "");
    if(target==="authorization_received")return context.html(renderEmailAuthorizationReceivedPage(),200,{
      "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options":"nosniff",
    });
    const url=versionedHostedAuthUrl(target,hostedAuthOrigin,v2HostedAuthOrigins);
    if(!url || !v2HostedAuthOrigins.includes(new URL(url).origin))throw new PublicError({status:502,code:"EMAIL_INVALID_HANDOFF",message:"Lifty could not prepare the email connection."});
    return context.redirect(url,303);
  });
  app.get("/unipile/linkedin/start", async (context) => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const target = await dependencies.authorizeLinkedin(context.req.query("intent") ?? "");
    const redirect = versionedHostedAuthUrl(target, hostedAuthOrigin,v2HostedAuthOrigins);
    if (!redirect) {
      throw new PublicError({ status: 502, code: "LINKEDIN_INVALID_HANDOFF", message: "LIFTY could not prepare the LinkedIn connection." });
    }
    return context.redirect(redirect, 303);
  });
  app.post("/unipile/linkedin/callback", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Invalid LinkedIn callback.");
    let payload: unknown;
    try { payload = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Invalid LinkedIn callback."); }
    await dependencies.completeLinkedinCallback(context.req.query("intent") ?? "", payload);
    return context.json({ ok: true });
  });
  app.get("/unipile/start", async (context) => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const state = context.req.query("intent") ?? "";
    let target: string;
    try { target = await dependencies.authorizeEmail(state); }
    catch (error) {
      if (!(error instanceof PublicError) || !["EMAIL_DECLARATION_REQUIRED", "EMAIL_PROVIDER_REQUIRED"].includes(error.code)) throw error;
      return context.html(renderEmailAuthorizationPage(state, error.code === "EMAIL_PROVIDER_REQUIRED"), 200, {
        "cache-control": "no-store", "referrer-policy": "strict-origin", "x-content-type-options": "nosniff",
        "content-security-policy": emailAuthorizationCsp,
      });
    }
    if (target === "authorization_received") {
      return context.html(renderEmailAuthorizationReceivedPage(), 200, {
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
    }
    const redirect = versionedHostedAuthUrl(target, hostedAuthOrigin,v2HostedAuthOrigins);
    if (!redirect) {
      throw new PublicError({status:502,code:"EMAIL_INVALID_HANDOFF",message:"LIFTY could not prepare the email connection."});
    }
    return context.redirect(redirect, 303);
  });
  app.post("/unipile/start", async context => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const origin = context.req.header("origin");
    // TLS terminates at the hosting proxy; compare with the configured public origin.
    const expectedOrigin = dependencies.emailAuthorizationOrigin ?? new URL(context.req.url).origin;
    if ((origin && origin !== expectedOrigin) || context.req.header("sec-fetch-site") === "cross-site") {
      return errorJson(context, 403, "INVALID_REQUEST", "Continue from the email authorization page.");
    }
    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return errorJson(context, 400, "INVALID_REQUEST", "Submit the email authorization form.");
    }
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Invalid email account declaration.");
    const form = new URLSearchParams(raw.text);
    if (form.getAll("intent").length !== 1 || form.getAll("mailbox_use").length !== 1
      || form.getAll("email_provider").length > 1
      || (form.has("email_provider") && !HostedEmailProvider.safeParse(form.get("email_provider")).success)
      || [...form.keys()].some(key => !["intent", "mailbox_use", "email_provider"].includes(key))
      || !["personal", "outreach"].includes(form.get("mailbox_use") ?? "")) {
      return errorJson(context, 400, "INVALID_REQUEST", "Say how you use this mailbox before continuing.");
    }
    const mailboxUse = form.get("mailbox_use") === "outreach" ? "outreach" as const : "personal" as const;
    const target = await dependencies.declareEmail(form.get("intent")!, form.has("email_provider") ? HostedEmailProvider.parse(form.get("email_provider")) : undefined, mailboxUse);
    if (target === "authorization_received") {
      return context.html(renderEmailAuthorizationReceivedPage(), 200, {
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
    }
    const redirect = versionedHostedAuthUrl(target, hostedAuthOrigin,v2HostedAuthOrigins);
    if (!redirect) {
      throw new PublicError({ status: 502, code: "EMAIL_INVALID_HANDOFF", message: "LIFTY could not prepare the email connection." });
    }
    return context.redirect(redirect, 303);
  });
  app.post("/unipile/callback", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Invalid email callback.");
    let payload: unknown;
    try { payload = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Invalid email callback."); }
    await dependencies.completeEmailCallback(context.req.query("intent") ?? "", payload);
    return context.json({ok:true});
  });
  app.get("/openapi.json", context => {
    const document = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: {
        title: "LIFTY Control Plane API",
        version: "1.0.0",
        description: "Authenticated REST boundary for LIFTY workspace provisioning.",
      },
    });
    // Match the shared authenticated boundary on every documented operation.
    for (const methods of Object.values(document.paths ?? {})) {
      for (const method of ["get", "post", "patch", "put", "delete"] as const) {
        const operation = methods?.[method];
        if (!operation?.security?.some(requirement => "bearerAuth" in requirement)) continue;
        operation.parameters = (operation.parameters ?? []).filter(parameter =>
          !("name" in parameter && parameter.in === "header" && parameter.name === "x-lifty-client-contract"));
        operation.parameters.push({ in: "header", name: "x-lifty-client-contract", required: true,
          schema: { type: "string", const: STAGE_CLIENT_CONTRACT } });
        operation.responses ??= {};
        operation.responses["409"] ??= { description: "Unsupported client contract; update the installed CLI and skill." };
      }
    }
    return context.json(document);
  });

  app.onError((error, context) => {
    const publicError = error instanceof PublicError
      ? error
      : new PublicError({
          status: 500,
          code: "INTERNAL_ERROR",
          message: "LIFTY could not complete the request.",
        });
    dependencies.log({
      level: publicError.status >= 500 ? "error" : "warn",
      event: "request_failed",
      request_id: context.get("requestId"),
      method: context.req.method,
      path: context.req.path,
      error_code: publicError.code,
      status: publicError.status,
      ...(context.get("operationStage") ? { stage: context.get("operationStage"), elapsed_ms: Date.now() - context.get("requestStartedAt") } : {}),
      ...publicError.diagnostics,
    });
    return context.json(
      {
        error: { code: publicError.code, message: publicError.message,
          ...(publicError.issues ? { issues: publicError.issues } : {}),
          ...(publicError.current_version === undefined ? {} : { current_version: publicError.current_version }),
          ...(publicError.stale_sources ? { stale_sources: publicError.stale_sources } : {}),
          ...(publicError.workspaces ? { workspaces: publicError.workspaces } : {}),

        },
        request_id: context.get("requestId"),
      },
      publicError.status as ContentfulStatusCode,
    );
  });

  // Task documentation is public so an agent can interview before sign-in.
  // Register only this GET before authentication; every business route stays scoped.
  app.get("/v1/context/:task", (context) => {
    context.header("cache-control", "no-store");
    // Unversioned public links show current documentation; authenticated calls
    // still require the explicit current contract below.
    const clientContract = context.req.query("client_contract") ?? STAGE_CLIENT_CONTRACT;
    if (clientContract !== STAGE_CLIENT_CONTRACT) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", CLIENT_UPGRADE_MESSAGE);
    }
    const document = getAgentContext(context.req.param("task"));
    if (!document) return errorJson(context, 404, "CONTEXT_NOT_FOUND", "No instructions are available for this task.");
    return context.json(document);
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/context/{task}", operationId: "getAgentTaskContext", security: [],
    request: {
      params: z.object({ task: z.string().min(1).max(64) }),
      query: z.object({ client_contract: z.string().optional() }),
    },
    responses: {
      200: { ...JsonResponse(AgentContextSchema), description: "Public task instructions and input schemas; no workspace data" },
      404: { description: "Unknown task" },
      409: { description: "Unsupported client contract" },
    },
  });

  app.use("/v1/*", async (context, next) => {
    if (context.req.path.startsWith("/v1/workspace/crm/")) context.header("cache-control", "no-store");
    const trusted = trustedMcpRequests.get(context.req.raw);
    trustedMcpRequests.delete(context.req.raw);
    const authentication = trusted ? { ok: true as const, session: trusted } : await dependencies.authenticate(context.req.raw);
    if (!authentication.ok) {
      return context.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "A valid LIFTY session is required.",
          },
          request_id: context.get("requestId"),
        },
        401,
      );
    }
    context.set("authSession", authentication.session);
    if (context.req.header("x-lifty-client-contract") !== STAGE_CLIENT_CONTRACT) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", CLIENT_UPGRADE_MESSAGE);
    }
    await next();
  });

  // One shared per-user budget for expensive provisioning/run operations.
  // Expired entries are removed on access, without a process-owning timer.
  app.use("/v1/*", async (context, next) => {
    if (context.req.method !== "POST" || ![
      "/v1/workspace/business", "/v1/workspace/setup", "/v1/workspace/runs", "/v1/integrations/hubspot/company-mapping", "/v1/email/connect", "/v1/email/accounts/connect", "/v1/email/warmup/start", "/v1/linkedin/connect",
      "/v1/workspace/crm", "/v1/workspace/notifications", "/v1/workspace/sending-accounts",
      "/v1/workspace/crm/mapping/apply", "/v1/workspace/crm/mapping/property_create", "/v1/workspace/crm/mapping/sync", "/v1/integrations/hubspot/sync",
    ].includes(context.req.path)) return next();
    const now = Date.now();
    for (const [key, window] of mutationWindows) {
      if (window.resetsAt <= now) mutationWindows.delete(key);
    }
    const userId = context.get("authSession").userId;
    const window = mutationWindows.get(userId) ?? { count: 0, resetsAt: now + 60_000 };
    if (window.count >= 10) {
      context.header("Retry-After", String(Math.ceil((window.resetsAt - now) / 1000)));
      return errorJson(context, 429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
    }
    window.count++;
    mutationWindows.set(userId, window);
    await next();
  });

  // ---------------------------------------------------------------- status

  registerStageRoutes(app, dependencies);

  // ---------------------------------------------------------------- workspace

  app.get("/v1/workspace", async (context) => {
    const result = await dependencies.getWorkspace(context.get("authSession"));
    return context.json(WorkspaceStatusSchema.parse(result));
  });

  app.post("/v1/workspace/runs", async (context) => {
    const result = StartRunResultSchema.parse(await dependencies.startRun(context.get("authSession")));
    // A quality checkpoint is terminal until targeting changes. Reattaching
    // returns its saved cohort without starting another acquisition job.
    if (result.state === "failed") return context.json(result);
    // Enqueue active starts, including re-attachments: the run-and-attempt-scoped
    // idempotency key makes it a no-op when the run is already enqueued and
    // self-heals an enqueue lost after the ledger insert.
    await dependencies.enqueueFirstRun(result.run_ref, result.attempt ?? 0);
    return context.json(StartRunResultSchema.parse(result));
  });

  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/workspace/runs/progress", operationId: "getRunProgress", security: [{ bearerAuth: [] }],
    request: { query: RunProgressQuerySchema },
    responses: { 200: JsonResponse(RunProgressSchema), 400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema), 404: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema), 429: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema), 504: JsonResponse(ErrorResponseSchema) },
  });
  app.get("/v1/workspace/runs/progress", async (context) => {
    context.header("cache-control", "no-store");
    const query = RunProgressQuerySchema.safeParse(context.req.query());
    if (!query.success) return errorJson(context, 400, "INVALID_REQUEST", "Supply a run_ref, optional cursor and wait_seconds from 0 to 25.");
    const result = await dependencies.getRunProgress(context.get("authSession"), query.data, context.req.raw.signal);
    return context.json(RunProgressSchema.parse(result));
  });

  app.get("/v1/workspace/runs", async (context) => {
    const result = await dependencies.getRunStatus(context.get("authSession"));
    return context.json(RunStatusSchema.parse(result));
  });

  app.get("/v1/integrations/hubspot/company-mapping/context", async (context) => {
    const workspaceRef = context.req.query("workspace_ref");
    if (workspaceRef !== undefined && !z.uuid().safeParse(workspaceRef).success) return errorJson(context, 400, "INVALID_WORKSPACE", "Select a valid workspace reference.");
    const result = await dependencies.companyMapping(context.get("authSession"), "context", undefined, {
      ...(workspaceRef === undefined ? {} : { workspaceRef }), signal: context.req.raw.signal,
    });
    return context.json(CompanyMappingContextSchema.parse(result));
  });
  app.post("/v1/integrations/hubspot/company-mapping", async (context) => {
    const body = await readRequestTextWithinLimit(context.req.raw, MAX_CREATE_WORKSPACE_BYTES);
    if (!body.ok) return errorJson(context, 413, "PAYLOAD_TOO_LARGE", "The company configuration exceeds 16 KiB.");
    let plan: unknown;
    try {
      plan = JSON.parse(body.text);
    } catch {
      return errorJson(context, 400, "INVALID_JSON", "Send a JSON company configuration.");
    }
    const result = await dependencies.companyMapping(context.get("authSession"), "apply", plan, { signal: context.req.raw.signal });
    return context.json(CompanyMappingReceiptSchema.parse(result));
  });

  // ------------------------------------------------------------ notifications

  app.get("/v1/notifications", async (context) => {
    const result = await dependencies.getNotificationConfig(
      context.get("authSession"),
    );
    return context.json(NotificationConfigSchema.parse(result));
  });

  app.get("/v1/notifications/slack/channels", async (context) => {
    const result = await dependencies.listSlackNotificationChannels(
      context.get("authSession"),
    );
    return context.json(SlackNotificationChannelsSchema.parse(result));
  });

  app.put("/v1/notifications/destinations/slack", async (context) => {
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The notification destination request exceeds 16 KiB.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const input = UpsertNotificationDestinationRequestSchema.safeParse(parsedJson);
    if (!input.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "Choose a valid Slack channel returned by the channel list.",
      );
    }
    const result = await dependencies.upsertNotificationDestination(
      context.get("authSession"),
      input.data,
    );
    return context.json(NotificationDestinationSchema.parse(result));
  });

  app.put("/v1/notifications/routes", async (context) => {
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The notification route request exceeds 16 KiB.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const input = SetNotificationRouteRequestSchema.safeParse(parsedJson);
    if (!input.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The notification route is invalid.",
      );
    }
    const result = await dependencies.setNotificationRoute(
      context.get("authSession"),
      input.data,
    );
    return context.json(NotificationRouteSchema.parse(result));
  });

  app.post(
    "/v1/notifications/destinations/:destination_ref/test",
    async (context) => {
      const destinationRef = DestinationRefSchema.safeParse(
        context.req.param("destination_ref"),
      );
      if (!destinationRef.success) {
        return errorJson(
          context,
          400,
          "INVALID_REQUEST",
          "The notification destination reference must be a UUID.",
        );
      }
      const result = await dependencies.enqueueNotificationTest(
        context.get("authSession"),
        destinationRef.data,
      );
      await dependencies.enqueueNotificationDelivery(result.delivery_ref);
      return context.json(NotificationTestResultSchema.parse(result));
    },
  );

  app.post("/v1/workspaces/:workspace_ref/retire", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Workspace retirement request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Confirm the workspace ID, slug and name."); }
    const confirmation = RetireWorkspaceConfirmation.safeParse(body);
    const input = confirmation.success ? RetireWorkspaceRequest.safeParse({...confirmation.data,workspace_ref:context.req.param("workspace_ref")}) : null;
    if (!input?.success) return errorJson(context, 400, "INVALID_REQUEST", "Confirm the exact workspace ID, slug and name.");
    return context.json(RetireWorkspaceResult.parse(await dependencies.retireWorkspace(context.get("authSession"), input.data)));
  });

  // Lists only the signed-in caller's own workspace memberships.
  app.get("/v1/me/workspaces", async (context) => {
    context.header("cache-control", "no-store");
    return context.json(MemberWorkspacesResult.parse(await dependencies.listMemberWorkspaces(context.get("authSession"))));
  });

  // Deletes only the signed-in caller's own login, after they type its email.
  app.post("/v1/me/delete", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Login deletion request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Confirm the email of the login you are signed in with."); }
    const input = DeleteLoginRequest.safeParse(body);
    if (!input.success) return errorJson(context, 400, "INVALID_REQUEST", "Confirm the email of the login you are signed in with.");
    return context.json(DeleteLoginResult.parse(await dependencies.deleteOwnLogin(context.get("authSession"), input.data)));
  });

  app.get("/v1/email/campaign/placement/preview", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = EmailCampaignRequest.safeParse({operation:"placement-preview",payload:context.req.query()});
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose the workspace, campaign and exact digest.");
    return context.json(EmailPlacementPreview.parse(await dependencies.emailCampaign(context.get("authSession"), parsed.data)));
  });

  app.get("/v1/email/campaign/placement", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = EmailCampaignRequest.safeParse({operation:"placement-status",payload:context.req.query()});
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose the workspace, campaign and exact digest.");
    return context.json(EmailPlacementResult.parse(await dependencies.emailCampaign(context.get("authSession"), parsed.data)));
  });

  app.post("/v1/linkedin/campaign", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 32 * 1024);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "LinkedIn campaign request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide one campaign request as JSON."); }
    const parsed = LinkedinCampaignRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Check the LinkedIn campaign operation, workspace and required fields.");
    const result = await dependencies.linkedinCampaign(context.get("authSession"), parsed.data);
    return context.json(linkedinCampaignResultFor(parsed.data, result));
  });
  app.post("/v1/linkedin/connect", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "LinkedIn connection request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide the workspace, timezone and account declarations."); }
    const parsed = LinkedinConnectRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose an IANA timezone and declare a personal account without other automation.");
    const result = LinkedinConnectResult.parse(await dependencies.startLinkedinConnect(context.get("authSession"), parsed.data));
    if (result.status === "pending") delete result.expires_at;
    return context.json(LegacyLinkedinConnectResult.parse(result));
  });
  app.get("/v1/linkedin", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = LinkedinWorkspaceRequest.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace.");
    return context.json(LinkedinConnectionStatus.parse(await dependencies.getLinkedinConnection(context.get("authSession"), parsed.data.workspace)));
  });
  app.post("/v1/linkedin/disconnect", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "LinkedIn request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace and confirm disconnection."); }
    const parsed = LinkedinDisconnectRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace and explicitly confirm disconnection.");
    return context.json(LinkedinConnectionStatus.parse(await dependencies.disconnectLinkedin(context.get("authSession"), parsed.data.workspace)));
  });

  app.post("/v1/email/campaign", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 128 * 1024);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Campaign request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide one campaign request as JSON."); }
    const parsed = EmailCampaignRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Check the campaign operation, workspace and required fields.");
    const result = await dependencies.emailCampaign(context.get("authSession"), parsed.data);
    return context.json(campaignResultFor(parsed.data.operation, result));
  });

  app.post("/v1/email/disconnect", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Email request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace."); }
    const parsed = z.object({workspace:EmailConnectRequest.shape.workspace}).strict().safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace explicitly.");
    return context.json(EmailConnectionStatus.parse(await dependencies.disconnectEmail(context.get("authSession"), parsed.data.workspace)));
  });

  app.post("/v1/email/connect", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Email connection request is too large.");
    let payload: unknown;
    try { payload = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide workspace and the current email connection fields."); }
    const parsed = EmailConnectRequest.safeParse(payload);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Provide workspace; legacy email and mailbox_use must be supplied together.");
    const result = EmailConnectResult.parse(await dependencies.startEmailConnect(context.get("authSession"), parsed.data));
    if (result.status === "pending") delete result.expires_at;
    return context.json(LegacyEmailConnectResult.parse(result));
  });
  app.get("/v1/email/warmup", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = WarmupWorkspaceRequest.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace.");
    const target: [string, string?] = parsed.data.connection_ref === undefined
      ? [parsed.data.workspace] : [parsed.data.workspace, parsed.data.connection_ref];
    return context.json(WarmupStatus.parse(await dependencies.getEmailWarmup(context.get("authSession"), ...target)));
  });
  // LIF-1042: the database authorizes scope, filters and cursor with the
  // caller's session; provider reports are read only for authorized tests.
  app.get("/v1/email/deliverability", async (context) => {
    context.header("cache-control", "no-store");
    const params = new URL(context.req.url).searchParams;
    if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return errorJson(context, 400, "INVALID_REQUEST", "Give each deliverability filter once.");
    const parsed = DeliverabilityQuery.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST",
      parsed.error.issues.find(issue => issue.code === "custom")?.message ?? "Choose a workspace and valid deliverability filters.");
    return context.json(DeliverabilityResponse.parse(await dependencies.getEmailDeliverability(context.get("authSession"), parsed.data)));
  });
  // LIF-1063: member-authorized placement tests for one warmed mailbox. The
  // database checks membership and the exact connection on every request.
  app.get("/v1/email/placement", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = PlacementStatusRequest.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace and, when it has several warmed mailboxes, a connection_ref.");
    return context.json(ConnectionPlacementStatus.parse(await dependencies.getEmailPlacement(context.get("authSession"), parsed.data)));
  });
  app.post("/v1/email/placement/start", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 32_768);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Placement request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide the workspace, test subject, body and confirm: true."); }
    const parsed = PlacementStartRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Provide the workspace, a subject, a body of at least 10 characters and confirm: true.");
    return context.json(ConnectionPlacementStatus.parse(await dependencies.startEmailPlacement(context.get("authSession"), parsed.data)));
  });
  // Explicit member workspace operations deliberately bypass founder-profile
  // adapters. The authenticated Edge owner checks membership on every request.
  app.get("/v1/email/accounts",async context=>{
    context.header("cache-control","no-store");
    const query=new URL(context.req.url).searchParams;
    if(query.getAll("workspace").length!==1)return errorJson(context,400,"INVALID_REQUEST","Choose one workspace.");
    const input=EmailAccountsRequest.safeParse(context.req.query());
    if(!input.success)return errorJson(context,400,"INVALID_REQUEST","Choose a workspace.");
    return context.json(EmailAccountsResult.parse(await dependencies.getEmailAccounts(context.get("authSession"),input.data)));
  });
  for(const operation of ["connect","connect/status"] as const) {
    app.post(`/v1/email/accounts/${operation}`,async context=>{
      context.header("cache-control","no-store");
      const raw=await readRequestTextWithinLimit(context.req.raw,8192);
      if(!raw.ok)return errorJson(context,413,"INVALID_REQUEST","Email account request is too large.");
      let body:unknown;
      try{body=JSON.parse(raw.text);}catch{return errorJson(context,400,"INVALID_REQUEST","Provide the requested email account fields.");}
      const session=context.get("authSession");
      if(operation==="connect") {
        const input=EmailAccountConnectRequest.safeParse(body);
        if(!input.success)return errorJson(context,400,"INVALID_REQUEST","Choose a workspace, sender and exact email address.");
        return context.json(EmailAccountConnectResult.parse(await dependencies.connectEmailAccount(session,input.data)));
      }
      const input=EmailAccountStatusRequest.safeParse(body);
      if(!input.success)return errorJson(context,400,"INVALID_REQUEST","Provide the workspace and retained connection attempt reference.");
      return context.json(EmailAccountStatusResult.parse(await dependencies.getEmailAccountAttempt(session,input.data)));
    });
  }
  for (const operation of ["start", "pause", "resume", "remove"] as const) {
    app.post(`/v1/email/warmup/${operation}`, async (context) => {
      context.header("cache-control", "no-store");
      const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
      if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Warmup request is too large.");
      let body: unknown;
      try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace."); }
      const parsed = WarmupWorkspaceRequest.safeParse(body);
      if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace explicitly.");
      const session = context.get("authSession");
      const connection: [] | [string] = parsed.data.connection_ref === undefined ? [] : [parsed.data.connection_ref];
      return context.json(operation === "start"
        ? WarmupStartResult.parse(await dependencies.startEmailWarmup(session, parsed.data.workspace, ...connection))
        : WarmupStatus.parse(await dependencies.changeEmailWarmup(session, parsed.data.workspace, operation, ...connection)));
    });
  }
  app.get("/v1/email", async (context) => {
    context.header("cache-control", "no-store");
    const workspace = EmailConnectRequest.shape.workspace.safeParse(context.req.query("workspace"));
    if (!workspace.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace.");
    return context.json(EmailConnectionStatus.parse(await dependencies.getEmailConnection(context.get("authSession"), workspace.data)));
  });

  // ---------------------------------------------------------------- integrations

  app.post("/v1/workspaces/:workspace_ref/integrations/slack/connect-link", async (context) => {
    const workspace = z.uuid().safeParse(context.req.param("workspace_ref"));
    if (!workspace.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a valid workspace.");
    const result = await dependencies.createSlackConnectLink(context.get("authSession"), workspace.data);
    context.header("cache-control", "no-store");
    return context.json(SlackConnectLinkSchema.parse(result));
  });

  app.post("/v1/integrations/:provider/connect", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider === "unipile") {
      return providerUnavailable(context, provider.provider);
    }
    const result = provider.provider === "hubspot"
      ? await dependencies.startHubspotConnect(context.get("authSession"))
      : await dependencies.startSlackConnect(context.get("authSession"));
    const validated = ProviderConnectStartSchema.parse(result);
    return context.json(LegacyProviderConnectStartSchema.parse({ provider: validated.provider,
      connect_url: validated.connect_url, expires_in_seconds: validated.expires_in_seconds }));
  });

  app.get("/v1/integrations/:provider", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider === "unipile") {
      // No connect path exists yet, so nothing can be connected.
      return context.json(
        IntegrationConnectionStatusSchema.parse({
          provider: provider.provider,
          status: "not_connected",
        }),
      );
    }
    const result = provider.provider === "hubspot"
      ? await dependencies.getHubspotConnection(context.get("authSession"))
      : await dependencies.getSlackConnection(context.get("authSession"));
    return context.json(IntegrationConnectionStatusSchema.parse(result));
  });

  app.delete("/v1/integrations/:provider", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    // Confirmation is the skill's job; the RPC refuses while a sync is in
    // flight and when nothing is connected.
    const result = await dependencies.disconnectIntegration(
      context.get("authSession"),
      provider.provider,
    );

    // LIF-681: the RPC detached the grant under a revocation row; ask the
    // provider to revoke it too, best effort. LIFT already cannot use the
    // grant, so a lost enqueue degrades to "not revoked at HubSpot", never to
    // a failed disconnect.
    if (result.revocation_ref) {
      try {
        await dependencies.enqueueIntegrationRevocation(result.revocation_ref);
      } catch (error) {
        dependencies.log({
          level: "error",
          event: "revocation_enqueue_failed",
          request_id: context.get("requestId"),
          method: context.req.method,
          path: context.req.path,
          error_code: error instanceof PublicError ? error.code : "REVOCATION_ENQUEUE_FAILED",
          status: error instanceof PublicError ? error.status : 502,
        });
      }
    }

    return context.json(
      DisconnectResponseSchema.parse({
        provider: result.provider,
        status: result.status,
        portal_id: result.portal_id,
        disconnected_at: result.disconnected_at,
        workspace: result.workspace,
      }),
    );
  });

  app.post("/v1/integrations/:provider/sync", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider !== "hubspot") {
      return providerUnavailable(context, provider.provider);
    }
    const result = await dependencies.startCrmSyncRun(
      context.get("authSession"),
    );
    // Enqueue on every start, including a re-attach — same self-healing
    // run-scoped idempotency as the first run.
    await dependencies.enqueueCrmSync(result.run_ref);
    return context.json(StartCrmSyncResultSchema.parse(result));
  });

  app.get("/v1/integrations/:provider/sync", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider !== "hubspot") {
      return providerUnavailable(context, provider.provider);
    }
    const result = await dependencies.getCrmSyncStatus(
      context.get("authSession"),
    );
    return context.json(CrmSyncStatusSchema.parse(result));
  });

  return app;
}
