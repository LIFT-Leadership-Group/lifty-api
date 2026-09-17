import type { CrmMappingOperation } from "./crm-mapping/contracts.js";
import { CrmMappingError } from "./crm-mapping.js";
import { LocalConfigUpdateConfigurationSchema, lintLocalConfigUpdateConfiguration, CONFIG_UPDATE_GENERATION_RULES } from "./generated/lifty-configuration.js";
import { registerStageRoutes } from "./stage-routes.js";
import { lintOnboardingDraft } from "./onboarding-draft.js";
import { renderEmailAuthorizationPage } from "./email-authorization-page.js";
import { getConnectionAttempt, type ConnectionAttemptStatus, type ConnectionProvider } from "./connection-attempt.js";
import {
  type CompanyMappingOperation,
  CompanyMappingContextSchema,
  CompanyMappingReceiptSchema,
  CompanyMappingError,
} from "./company-mapping.js";
import {
  AcquisitionRecoveryBody,
  AcquisitionRecoveryStatus,
  AcquisitionRestartResult,
  type AcquisitionRecoveryInput,
  type AcquisitionRecoveryOutput,
} from "./acquisition-recovery.js";
import { ApolloAllowanceSchema, type ApolloAllowance } from "./apollo-allowance.js";
import { ApolloCredentialChoice, ApolloCredentialResult, type ApolloCredentialInput, type ApolloCredentialOutput } from "./apollo-credentials.js";
import { RetireWorkspaceRequest, RetireWorkspaceConfirmation, RetireWorkspaceResult, type RetireWorkspaceInput, type RetireWorkspaceOutput } from "./workspace-retirement.js";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { AGENT_CLIENT_CONTRACT, COMPANY_MAPPING_CLIENT_CONTRACT, LOCAL_CONFIG_CLIENT_CONTRACT, CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT, AgentContextSchema, getAgentContext } from "./agent-context.js";
import { lintLocalOnboardingConfiguration, OnboardingLintIssueSchema, onboardingRepairIssues, ONBOARDING_GENERATION_RULES, type OnboardingLintIssue } from "./onboarding-lint.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  ConfigUpdateContextSchema,
  ConfigUpdateGenerationContextSchema,
  type ConfigUpdateContext,
  ConfigSectionSchema,
  ConfigUpdateRequestSchema,
  ConfigUpdateResultSchema,
  ConfigUpdateStatusSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResultSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResult,
  DisconnectResponseSchema,
  IntegrationConnectionStatusSchema,
  OnboardingContextSchema,
  OnboardingGenerationContextSchema,
  LocalOnboardingConfigurationSchema,
  OnboardingPushResultSchema,
  OnboardingStatusSchema,
  NotificationConfigSchema,
  NotificationDestinationSchema,
  NotificationRouteSchema,
  NotificationTestResultSchema,
  SetNotificationRouteRequestSchema,
  SlackNotificationChannelsSchema,
  UpsertNotificationDestinationRequestSchema,
  ProviderConnectStartSchema,
  LegacyProviderConnectStartSchema,
  SlackConnectLinkSchema,
  type SlackConnectLink,
  ProviderSchema,
  RunStatusSchema,
  StartRunResultSchema,
  StartCrmSyncResultSchema,
  CrmSyncStatusSchema,
  SubmitOnboardingRequestSchema,
  WorkspaceConfigSchema,
  WorkspaceOverviewSchema,
  type ConfigSection,
  type ConfigUpdateRequest,
  type ConfigUpdateStatus,
  type ConfigUpdateSubmission,
  type DisconnectResult,
  type HubspotConnectStart,
  type HubspotConnectionStatus,
  type OnboardingContext,
  type LocalOnboardingConfiguration,
  type OnboardingStatus,
  type OnboardingSubmission,
  type NotificationConfig,
  type NotificationDestination,
  type NotificationRoute,
  type NotificationTestResult,
  type SetNotificationRouteRequest,
  type SlackNotificationChannels,
  type UpsertNotificationDestinationRequest,
  type Provider,
  type SlackConnectStart,
  type SlackConnectionStatus,
  type RunStatus,
  type StartRunResult,
  type StartCrmSyncResult,
  type CrmSyncStatus,
  type WorkspaceConfig,
  WorkspaceStatusSchema,
  type WorkspaceStatus,
} from "./contracts.js";
import type {
  EnqueueConfigUpdate,
  EnqueueCrmSync,
  EnqueueFirstRun,
  EnqueueIntegrationRevocation,
  EnqueueOnboardingImport,
  EnqueueNotificationDelivery,
} from "./trigger-client.js";
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
import { EmailConnectRequest, EmailConnectResult, LegacyEmailConnectResult, EmailConnectionStatus, type EmailConnectInput, type EmailStart, type EmailStatus } from "./email-contracts.js";

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

export type { OnboardingPushResult, WorkspaceStatus } from "./contracts.js";

export interface AppDependencies {
  getConnectionAttempt(session: AuthSession, provider: ConnectionProvider, attemptRef: string, workspace: string): Promise<ConnectionAttemptStatus>;
  acquisitionRecovery(session: AuthSession, input: AcquisitionRecoveryInput): Promise<AcquisitionRecoveryOutput>;
  getApolloAllowance(session: AuthSession, workspace: string): Promise<ApolloAllowance>;
  apolloCredentials(session: AuthSession, workspace: string, input: ApolloCredentialInput): Promise<ApolloCredentialOutput>;
  retireWorkspace(session: AuthSession, input: RetireWorkspaceInput): Promise<RetireWorkspaceOutput>;
  emailCampaign(session: AuthSession, input: EmailCampaignInput): Promise<EmailCampaignOutput>;
  linkedinCampaign(session: AuthSession, input: LinkedinCampaignInput): Promise<LinkedinCampaignOutput>;
  startLinkedinConnect(session: AuthSession, input: LinkedinConnectInput): Promise<LinkedinStart>;
  getLinkedinConnection(session: AuthSession, workspace: string, attemptRef?: string): Promise<LinkedinStatus>;
  disconnectLinkedin(session: AuthSession, workspace: string): Promise<LinkedinStatus>;
  authorizeLinkedin(state: string): Promise<string>;
  completeLinkedinCallback(state: string, body: unknown): Promise<void>;
  emailAvailable: boolean;
  startEmailConnect(session: AuthSession, input: EmailConnectInput): Promise<EmailStart>;
  getEmailConnection(session: AuthSession, workspace: string, attemptRef?: string): Promise<EmailStatus>;
  disconnectEmail(session: AuthSession, workspace: string): Promise<EmailStatus>;
  authorizeEmail(state: string): Promise<string>;
  declareEmail(state: string): Promise<string>;
  completeEmailCallback(state: string, body: unknown): Promise<void>;
  authenticate(request: Request): Promise<AuthenticationResult>;
  getWorkspace(session: AuthSession): Promise<WorkspaceStatus>;
  createWorkspace(
    session: AuthSession,
    input: CreateWorkspaceRequest,
  ): Promise<CreateWorkspaceResult>;
  submitOnboarding(
    session: AuthSession,
    draft: Record<string, unknown>,
    configuration: LocalOnboardingConfiguration,
  ): Promise<OnboardingSubmission>;
  getOnboardingContext(session: AuthSession): Promise<OnboardingContext>;
  getOnboardingStatus(session: AuthSession): Promise<OnboardingStatus>;
  enqueueOnboardingImport: EnqueueOnboardingImport;
  startRun(session: AuthSession): Promise<StartRunResult>;
  getRunStatus(session: AuthSession): Promise<RunStatus>;
  enqueueFirstRun: EnqueueFirstRun;
  startCrmSyncRun(session: AuthSession): Promise<StartCrmSyncResult>;
  getCrmSyncStatus(session: AuthSession): Promise<CrmSyncStatus>;
  runCrmMapping: CrmMappingOperation;
  enqueueCrmSync: EnqueueCrmSync;
  getConfigUpdateContext(session: AuthSession): Promise<ConfigUpdateContext>;
  getConfig(session: AuthSession, section: ConfigSection | null): Promise<WorkspaceConfig>;
  submitConfigUpdate(
    session: AuthSession,
    payload: ConfigUpdateRequest,
  ): Promise<ConfigUpdateSubmission>;
  resolveConfigUpdate(session: AuthSession, payload: ConfigUpdateRequest): Promise<ConfigUpdateStatus>;
  getConfigUpdateStatus(
    session: AuthSession,
    submissionRef: string | null,
  ): Promise<ConfigUpdateStatus>;
  enqueueConfigUpdate: EnqueueConfigUpdate;
  requeueConfigUpdate(session: AuthSession, submissionRef: string): Promise<ConfigUpdateStatus>;
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
  log(event: LogEvent): void;
}

export interface LogEvent {
  level: "warn" | "error";
  event: "request_failed" | "revocation_enqueue_failed";
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
    issues: z.array(OnboardingLintIssueSchema).max(20).optional(),
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
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/workspaces/{workspace_ref}/apollo/recovery/{first_run_ref}",
    operationId: "getAcquisitionRecovery",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ workspace_ref: z.uuid(), first_run_ref: z.uuid() }) },
    responses: {
      200: JsonResponse(AcquisitionRecoveryStatus),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspaces/{workspace_ref}/apollo/recovery/{first_run_ref}",
    operationId: "requestOrRestartAcquisition",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ workspace_ref: z.uuid(), first_run_ref: z.uuid() }),
      body: {
        required: true,
        content: { "application/json": { schema: AcquisitionRecoveryBody } },
      },
    },
    responses: {
      200: JsonResponse(z.union([AcquisitionRecoveryStatus, AcquisitionRestartResult])),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/workspaces/{workspace_ref}/apollo/allowance",operationId:"getApolloAllowance",security:[{bearerAuth:[]}],request:{params:z.object({workspace_ref:z.uuid()})},responses:{200:JsonResponse(ApolloAllowanceSchema),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/workspaces/{workspace_ref}/integrations/apollo/key-source",operationId:"getApolloCredentialChoice",security:[{bearerAuth:[]}],
    request:{params:z.object({workspace_ref:z.uuid()})},
    responses:{200:JsonResponse(ApolloCredentialResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/workspaces/{workspace_ref}/integrations/apollo/key-source",operationId:"setApolloCredentialChoice",security:[{bearerAuth:[]}],
    request:{params:z.object({workspace_ref:z.uuid()}),body:{required:true,content:{"application/json":{schema:ApolloCredentialChoice}}}},
    responses:{200:JsonResponse(ApolloCredentialResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/workspaces/{workspace_ref}/retire",operationId:"retireWorkspace",security:[{bearerAuth:[]}],
    request:{params:z.object({workspace_ref:z.uuid()}),body:{required:true,content:{"application/json":{schema:RetireWorkspaceConfirmation}}}},
    responses:{200:JsonResponse(RetireWorkspaceResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
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
    path: "/v1/status",
    operationId: "getStatus",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(WorkspaceOverviewSchema),
      409: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
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
    path: "/v1/workspace",
    operationId: "createWorkspace",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: CreateWorkspaceRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(CreateWorkspaceResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      429: JsonResponse(ErrorResponseSchema),
      413: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/onboarding",
    operationId: "submitOnboarding",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: SubmitOnboardingRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(OnboardingPushResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      429: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      413: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/config/context", operationId: "getConfigUpdateContext",
    security: [{ bearerAuth: [] }], responses: {
      200: JsonResponse(ConfigUpdateGenerationContextSchema), 401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/onboarding/context",
    operationId: "getOnboardingContext",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(OnboardingGenerationContextSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/onboarding",
    operationId: "getOnboardingStatus",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(OnboardingStatusSchema),
      401: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspace/runs",
    operationId: "startRun",
    security: [{ bearerAuth: [] }],
    request: { headers: z.object({ "x-lifty-client-contract": z.enum([CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT]) }) },
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
    method: "get",
    path: "/v1/config",
    operationId: "getConfig",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(WorkspaceConfigSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/config/{section}",
    operationId: "getConfigSection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        section: ConfigSectionSchema.openapi({ param: { name: "section", in: "path" } }),
      }),
    },
    responses: {
      200: JsonResponse(WorkspaceConfigSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "patch",
    path: "/v1/config",
    operationId: "updateConfig",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ConfigUpdateRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(ConfigUpdateResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      413: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post", path: "/v1/config/updates/resolve", operationId: "resolveConfigUpdate",
    security: [{ bearerAuth: [] }],
    description: "Read the status of the exact original local update without changing or enqueueing it.",
    request: { body: { required: true, content: { "application/json": { schema: ConfigUpdateRequestSchema } } } },
    responses: { 200: JsonResponse(ConfigUpdateStatusSchema), 400: JsonResponse(ErrorResponseSchema), 401: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema), 413: JsonResponse(ErrorResponseSchema), 502: JsonResponse(ErrorResponseSchema) },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/config/updates/{submission_ref}",
    operationId: "getConfigUpdateStatus",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        submission_ref: SubmissionRefSchema.openapi({
          param: { name: "submission_ref", in: "path" },
        }),
      }),
    },
    responses: {
      200: JsonResponse(ConfigUpdateStatusSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      404: JsonResponse(ErrorResponseSchema),
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0b0d10; color: #f4f4f5; }
    main { width: min(92vw, 420px); }
    .brand { letter-spacing: .18em; font-size: .82rem; font-weight: 800; margin: 0 0 1.25rem; }
    .card { border: 1px solid #2a2e35; border-radius: 16px; padding: 1.5rem; background: #14171c; box-shadow: 0 18px 60px #0008; }
    .icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 1rem; }
    .icon.success { background: #86efac22; color: #86efac; }
    .icon.error { background: #fda4af22; color: #fda4af; }
    h1 { margin: 0 0 .5rem; font-size: 1.45rem; }
    p { color: #a9afb9; line-height: 1.5; margin: 0 0 .75rem; }
    .hint { margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid #2a2e35; font-size: .9rem; }
  </style>
</head>
<body>
  <main>
    <p class="brand">LIFTY</p>
    <section class="card">
      <div class="icon ${success ? "success" : "error"}" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath}"></path></svg>
      </div>
      <h1>${title}</h1>
      <p>${message}</p>
      <p class="hint">You can close this tab.</p>
    </section>
  </main>
</body>
</html>`;
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
  issues?: OnboardingLintIssue[],
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
  denyHubspotCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  denySlackCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  getApolloAllowance: async () => { throw new PublicError({status:503,code:"APOLLO_ALLOWANCE_UNAVAILABLE",message:"Apollo allowance is not configured yet."}); },
  acquisitionRecovery: async () => {
    throw new PublicError({
      status: 503,
      code: "ACQUISITION_RECOVERY_UNAVAILABLE",
      message: "Acquisition recovery is not configured.",
    });
  },
  apolloCredentials: async () => { throw new PublicError({status:503,code:"APOLLO_CREDENTIAL_UNAVAILABLE",message:"Apollo credential configuration is unavailable."}); },
  retireWorkspace: async () => { throw new PublicError({status:503,code:"WORKSPACE_RETIREMENT_UNAVAILABLE",message:"Workspace retirement is not configured yet."}); },
  linkedinCampaign: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn campaigns are not configured yet." }); },
  startLinkedinConnect: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  getLinkedinConnection: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  disconnectLinkedin: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  authorizeLinkedin: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  completeLinkedinCallback: async () => { throw new PublicError({ status: 503, code: "LINKEDIN_NOT_CONFIGURED", message: "LinkedIn connection is not configured yet." }); },
  emailCampaign: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email campaigns are not configured yet."}); },
  disconnectEmail: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  emailAvailable: false,
  startEmailConnect: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  getEmailConnection: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  authorizeEmail: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  completeEmailCallback: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email connection is not configured yet."}); },
  authenticate: async () => ({ ok: false, reason: "invalid_session" }),
  getWorkspace: async () => {
    throw new Error("getWorkspace is not configured");
  },
  createWorkspace: async () => {
    throw new Error("createWorkspace is not configured");
  },
  submitOnboarding: async () => {
    throw new Error("submitOnboarding is not configured");
  },
  getOnboardingContext: async () => {
    throw new Error("getOnboardingContext is not configured");
  },
  getOnboardingStatus: async () => {
    throw new Error("getOnboardingStatus is not configured");
  },
  enqueueOnboardingImport: async () => {
    throw new Error("enqueueOnboardingImport is not configured");
  },
  startRun: async () => {
    throw new Error("startRun is not configured");
  },
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
  getConfig: async () => {
    throw new Error("getConfig is not configured");
  },
  getConfigUpdateContext: async () => { throw new Error("getConfigUpdateContext is not configured"); },
  submitConfigUpdate: async () => {
    throw new Error("submitConfigUpdate is not configured");
  },
  resolveConfigUpdate: async () => { throw new Error("resolveConfigUpdate is not configured"); },
  getConfigUpdateStatus: async () => {
    throw new Error("getConfigUpdateStatus is not configured");
  },
  enqueueConfigUpdate: async () => {
    throw new Error("enqueueConfigUpdate is not configured");
  },
  requeueConfigUpdate: async () => {
    throw new Error("requeueConfigUpdate is not configured");
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
  const app = new OpenAPIHono<AppEnvironment>();
  registerOpenApi(app);
  const mutationWindows = new Map<string, { count: number; resetsAt: number }>();

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
  app.get("/hubspot/callback", async (context) => {
    if (context.req.query("error")) {
      const state = context.req.query("state") ?? "";
      if (isSealedHubspotState(state)) {
        try { await dependencies.denyHubspotCallback(state); }
        catch { return hubspotHtmlResponse(context, 503, "Authorization could not be verified", "The outcome could not be recorded. Return to Lifty to check the same attempt."); }
      }
      return hubspotHtmlResponse(
        context,
        400,
        "HubSpot authorization was not completed",
        "This attempt did not save a connection. If HubSpot blocked permissions, ask a HubSpot super admin "
          + "to approve Lifty and its required permissions in Settings > Integrations > Connected Apps > Approved apps. "
          + "Ask Lifty for a fresh HubSpot link when the admin is ready, and share that link with them. "
          + "They can complete the connection without your Lifty login. If you cancelled, ask Lifty to retry when you are ready.",
      );
    }

    const code = context.req.query("code") ?? "";
    const state = context.req.query("state") ?? "";
    if (!code || code.length > 4096 || !isSealedHubspotState(state)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid HubSpot callback",
        "No connection was saved. Ask LIFTY for a fresh link.",
      );
    }

    try {
      await dependencies.completeHubspotCallback({ code, state });
      return hubspotHtmlResponse(
        context,
        200,
        "HubSpot is connected",
        "LIFTY verified and saved the connection.",
      );
    } catch (error) {
      const callbackError = error instanceof HubspotCallbackError
        ? error
        : new HubspotCallbackError(
            "internal_error",
            500,
            "LIFTY could not complete the HubSpot connection.",
          );
      dependencies.log({
        level: callbackError.status >= 500 ? "error" : "warn",
        event: "request_failed",
        request_id: context.get("requestId"),
        method: context.req.method,
        path: context.req.path,
        error_code: `HUBSPOT_CALLBACK_${callbackError.reason.toUpperCase()}`,
        status: callbackError.status,
      });
      return hubspotHtmlResponse(
        context,
        callbackError.status as ContentfulStatusCode,
        "HubSpot connection failed",
        callbackError.safeMessage,
      );
    }
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
  app.get("/slack/callback", async (context) => {
    if (context.req.query("error")) {
      const state = context.req.query("state") ?? "";
      if (isSealedSlackState(state)) {
        try { await dependencies.denySlackCallback(state); }
        catch { return hubspotHtmlResponse(context, 503, "Authorization could not be verified", "The outcome could not be recorded. Return to Lifty to check the same attempt."); }
      }
      return hubspotHtmlResponse(
        context,
        400,
        "Slack authorization was cancelled",
        "No connection was saved. Ask LIFTY for a fresh link when you are ready.",
      );
    }

    const code = context.req.query("code") ?? "";
    const state = context.req.query("state") ?? "";
    if (!code || code.length > 4096 || !isSealedSlackState(state)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid Slack callback",
        "No connection was saved. Ask LIFTY for a fresh link.",
      );
    }

    try {
      await dependencies.completeSlackCallback({ code, state });
      return hubspotHtmlResponse(
        context,
        200,
        "Slack is connected",
        "Your Slack workspace is connected. Invite @Lifty to the channel where you want notifications, then let LIFT know which channel you chose.",
      );
    } catch (error) {
      const callbackError = error instanceof SlackCallbackError
        ? error
        : new SlackCallbackError(
            "internal_error",
            500,
            "LIFTY could not complete the Slack connection.",
          );
      dependencies.log({
        level: callbackError.status >= 500 ? "error" : "warn",
        event: "request_failed",
        request_id: context.get("requestId"),
        method: context.req.method,
        path: context.req.path,
        error_code: `SLACK_CALLBACK_${callbackError.reason.toUpperCase()}`,
        status: callbackError.status,
      });
      return hubspotHtmlResponse(
        context,
        callbackError.status as ContentfulStatusCode,
        "Slack connection failed",
        callbackError.safeMessage,
      );
    }
  });
  app.get("/unipile/linkedin/start", async (context) => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const target = await dependencies.authorizeLinkedin(context.req.query("intent") ?? "");
    const url = new URL(target);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port || url.username || url.password || url.hash) {
      throw new PublicError({ status: 502, code: "LINKEDIN_INVALID_HANDOFF", message: "LIFTY could not prepare the LinkedIn connection." });
    }
    return context.redirect(target, 303);
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
      if (!(error instanceof PublicError) || error.code !== "EMAIL_DECLARATION_REQUIRED") throw error;
      return context.html(renderEmailAuthorizationPage(state), 200, {
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
    }
    const url = new URL(target);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port || url.username || url.password || url.hash) {
      throw new PublicError({status:502,code:"EMAIL_INVALID_HANDOFF",message:"LIFTY could not prepare the email connection."});
    }
    return context.redirect(target, 303);
  });
  app.post("/unipile/start", async context => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const origin = context.req.header("origin");
    if ((origin && origin !== new URL(context.req.url).origin) || context.req.header("sec-fetch-site") === "cross-site") {
      return errorJson(context, 403, "INVALID_REQUEST", "Continue from the email authorization page.");
    }
    if (!context.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return errorJson(context, 400, "INVALID_REQUEST", "Submit the email authorization form.");
    }
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Invalid email account declaration.");
    const form = new URLSearchParams(raw.text);
    if (form.getAll("intent").length !== 1 || form.getAll("mailbox_use").length !== 1
      || [...form.keys()].some(key => !["intent", "mailbox_use"].includes(key)) || form.get("mailbox_use") !== "personal") {
      return errorJson(context, 400, "INVALID_REQUEST", "Confirm your regular personal mailbox before continuing.");
    }
    const target = await dependencies.declareEmail(form.get("intent")!);
    const url = new URL(target);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port || url.username || url.password || url.hash) {
      throw new PublicError({ status: 502, code: "EMAIL_INVALID_HANDOFF", message: "LIFTY could not prepare the email connection." });
    }
    return context.redirect(target, 303);
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
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "LIFTY Control Plane API",
      version: "1.0.0",
      description: "Authenticated REST boundary for LIFTY workspace provisioning.",
    },
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
          ...(publicError instanceof CompanyMappingError || publicError instanceof CrmMappingError ? { issues: publicError.issues } : {}),
          ...(context.req.path === "/v1/onboarding" && onboardingRepairIssues(publicError.code)
            ? { issues: onboardingRepairIssues(publicError.code) } : {}),
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
    // Existing bootstrap defaults retain their upgrade gate. New stage links
    // are directly readable without a client version query parameter.
    const clientContract = context.req.query("client_contract")
      ?? (["onboarding", "workspace", "campaign"].includes(context.req.param("task"))
        ? AGENT_CLIENT_CONTRACT : STAGE_CLIENT_CONTRACT);
    if (![AGENT_CLIENT_CONTRACT, COMPANY_MAPPING_CLIENT_CONTRACT, LOCAL_CONFIG_CLIENT_CONTRACT, CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT].includes(clientContract)) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", "Update the installed LIFTY CLI and skill to retrieve current instructions.");
    }
    const document = getAgentContext(context.req.param("task"), clientContract);
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
    const authentication = await dependencies.authenticate(context.req.raw);
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
    await next();
  });

  // One shared per-user budget for expensive provisioning/run operations.
  // Expired entries are removed on access, without a process-owning timer.
  app.use("/v1/*", async (context, next) => {
    if (context.req.method !== "POST" || ![
      "/v1/workspace", "/v1/onboarding", "/v1/workspace/runs", "/v1/integrations/hubspot/company-mapping", "/v1/email/connect", "/v1/linkedin/connect",
      "/v1/workspace/crm", "/v1/workspace/notifications", "/v1/workspace/sending-accounts",
      "/v1/workspace/crm/mapping/apply", "/v1/workspace/crm/mapping/property_create", "/v1/workspace/crm/mapping/sync",
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

  // One aggregate read so `lifty status` answers "is my HubSpot OK?" without
  // ever touching OAuth: workspace, onboarding import, first run, the latest
  // live ICP version, config update, and per-provider connection + last sync.
  app.get("/v1/status", async (context) => {
    const session = context.get("authSession");
    const workspace = await dependencies.getWorkspace(session);
    if (workspace.state === "needs_workspace") {
      return context.json(
        WorkspaceOverviewSchema.parse({
          workspace: { state: "needs_workspace" },
          onboarding: { state: "none" },
          configuration: { icp_version: null },
          run: { state: "none" },
          config_update: { state: "none" },
          integrations: {
            hubspot: {
              available: true,
              connected: false,
              portal_id: null,
              hub_domain: null,
              connected_at: null,
              reconnect_required: false,
              sync_pending: false,
              last_sync_at: null,
              last_sync: { state: "none" },
            },
            unipile: { available: false, connected: false },
          },
        }),
      );
    }

    const [onboarding, config, run, sync, hubspot, configUpdate, email] = await Promise.all([
      dependencies.getOnboardingStatus(session),
      dependencies.getConfig(session, "icp").then(
        (value) => ({ icp_version: value.config.icp?.version ?? null }),
        (error: unknown) => {
          if (error instanceof PublicError && error.code === "MULTI_LANE_CONFIG_UNSUPPORTED") {
            return { icp_version: null, managed_externally: true };
          }
          throw error;
        },
      ),
      dependencies.getRunStatus(session),
      dependencies.getCrmSyncStatus(session),
      dependencies.getHubspotConnection(session),
      dependencies.getConfigUpdateStatus(session, null),
      dependencies.emailAvailable ? dependencies.getEmailConnection(session, workspace.workspace.workspace_ref) : Promise.resolve(null),
    ]);

    return context.json(
      WorkspaceOverviewSchema.parse({
        workspace: {
          state: workspace.state,
          workspace_ref: workspace.workspace.workspace_ref,
          name: workspace.workspace.name,
        },
        onboarding: onboarding.state === "none"
          ? { state: "none" }
          : {
              state: onboarding.state,
              submission_ref: onboarding.submission_ref,
              submitted_at: onboarding.submitted_at,
              error_code: onboarding.error_code ?? null,
            },
        configuration: config,
        run: run.state === "none"
          ? { state: "none" }
          : {
              state: run.state,
              run_ref: run.run_ref,
              requested_leads: run.requested_leads,
              leads_discovered: run.leads_discovered,
              leads_researched: run.leads_researched,
              error_code: run.error_code,
              started_at: run.started_at,
              completed_at: run.completed_at,
            },
        config_update: configUpdate,
        integrations: {
          hubspot: {
            available: true,
            connected: hubspot.status === "connected",
            portal_id: hubspot.status === "connected" ? hubspot.portal_id : null,
            hub_domain: hubspot.status === "connected" ? hubspot.hub_domain : null,
            connected_at: hubspot.status === "connected" ? hubspot.connected_at : null,
            reconnect_required: hubspot.status === "connected"
              ? hubspot.reconnect_required
              : false,
            sync_pending: sync.state === "queued" || sync.state === "running",
            last_sync_at: sync.state === "none" ? null : sync.completed_at,
            last_sync: sync.state === "none"
              ? { state: "none" }
              : {
                  state: sync.state,
                  run_ref: sync.run_ref,
                  requested_leads: sync.requested_leads,
                  leads_synced: sync.leads_synced,
                  error_code: sync.error_code,
                  started_at: sync.started_at,
                  completed_at: sync.completed_at,
                },
          },
          unipile: { available: dependencies.emailAvailable, connected: email?.status === "connected" },
        },
      }),
    );
  });

  // ---------------------------------------------------------------- workspace

  app.get("/v1/workspace", async (context) => {
    const result = await dependencies.getWorkspace(context.get("authSession"));
    return context.json(WorkspaceStatusSchema.parse(result));
  });

  app.post("/v1/workspace", async (context) => {
    const declaredLength = Number(context.req.header("content-length"));
    if (
      Number.isFinite(declaredLength)
      && declaredLength > MAX_CREATE_WORKSPACE_BYTES
    ) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The workspace request exceeds 16 KiB.",
      );
    }
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The workspace request exceeds 16 KiB.",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const body = CreateWorkspaceRequestSchema.safeParse(parsedJson);
    if (!body.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The workspace request must contain a non-empty name and an optional description.",
      );
    }

    const result = await dependencies.createWorkspace(
      context.get("authSession"),
      body.data,
    );
    return context.json(CreateWorkspaceResultSchema.parse(result));
  });

  app.post("/v1/onboarding", async (context) => {
    const declaredLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The onboarding push exceeds 132 KiB.",
      );
    }
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_REQUEST_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The onboarding push exceeds 132 KiB.",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const envelope = z.object({
      draft: z.record(z.string(), z.unknown()),
      configuration: z.unknown().optional(),
    }).strict().safeParse(parsedJson);
    if (!envelope.success) {
      return errorJson(context, 400, "INVALID_REQUEST",
        "The onboarding push must contain JSON objects named draft and configuration.");
    }
    if (envelope.data.configuration == null) {
      return errorJson(context, 422, "LOCAL_CONFIGURATION_REQUIRED",
        "Upgrade LIFTY and its onboarding skill, fetch fresh onboarding context, and generate the configuration locally before pushing.");
    }
    const lint = lintLocalOnboardingConfiguration(envelope.data.configuration, envelope.data.draft, undefined, {
      requireDiscoveryIntent: [CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT].includes(context.req.header("x-lifty-client-contract") ?? ""),
    });
    if (!lint.success) {
      return errorJson(context, 422, "LOCAL_CONFIGURATION_INVALID",
        "Repair the local configuration using these issues and push it again.", lint.issues);
    }
    const generationContext = await dependencies.getOnboardingContext(context.get("authSession"));
    const contextualLint = lintLocalOnboardingConfiguration(lint.configuration, envelope.data.draft, generationContext.scout_global_base);
    if (!contextualLint.success) {
      return errorJson(context, 422, "LOCAL_CONFIGURATION_INVALID",
        "Repair the local configuration using these issues and push it again.", contextualLint.issues);
    }
    // Writers only protect local artifacts. The current server validates full
    // confirmation/readiness semantics for every client before persistence.
    const draftIssues = lintOnboardingDraft(envelope.data.draft);
    if (draftIssues.length) return errorJson(context, 422, "ONBOARDING_DRAFT_INVALID",
      "Repair the confirmed draft using the current API schema before submitting configuration.", draftIssues);

    const submission = await dependencies.submitOnboarding(
      context.get("authSession"),
      envelope.data.draft,
      lint.configuration,
    );

    // An already-imported draft needs no run; anything else gets exactly one.
    // A previously failed import must not dedupe onto its dead run.
    let runId: string | null = null;
    if (submission.import_status !== "imported") {
      const run = await dependencies.enqueueOnboardingImport(
        submission.submission_ref,
        { fresh: submission.import_status === "failed" },
      );
      runId = run.id;
    }

    return context.json(
      OnboardingPushResultSchema.parse({
        state: submission.import_status === "imported" ? "imported" : "queued",
        run_id: runId,
        submission_ref: submission.submission_ref,
        draft_digest: submission.draft_digest,
        workspace: submission.workspace,
        created: submission.created,
      }),
    );
  });

  app.get("/v1/onboarding/context", async (context) => {
    context.header("cache-control", "no-store");
    const result = await dependencies.getOnboardingContext(context.get("authSession"));
    return context.json(OnboardingGenerationContextSchema.parse({
      ...OnboardingContextSchema.parse(result),
      generation_rules: ONBOARDING_GENERATION_RULES,
      configuration_schema: z.toJSONSchema(LocalOnboardingConfigurationSchema),
    }));
  });

  app.get("/v1/onboarding", async (context) => {
    const result = await dependencies.getOnboardingStatus(
      context.get("authSession"),
    );
    return context.json(OnboardingStatusSchema.parse(result));
  });

  app.post("/v1/workspace/runs", async (context) => {
    if (![CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT].includes(context.req.header("x-lifty-client-contract") ?? "")) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", "Upgrade the installed Lifty CLI and skills before starting or resuming calibration. Your saved candidates remain available through status.");
    }
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

  app.get("/v1/workspace/runs", async (context) => {
    const result = await dependencies.getRunStatus(context.get("authSession"));
    return context.json(RunStatusSchema.parse(result));
  });

  // ---------------------------------------------------------------- config

  app.get("/v1/config", async (context) => {
    const result = await dependencies.getConfig(context.get("authSession"), null);
    return context.json(WorkspaceConfigSchema.parse(result));
  });

  app.get("/v1/config/context", async (context) => {
    context.set("operationStage", "config_context");
    context.header("cache-control", "no-store");
    const result = await dependencies.getConfigUpdateContext(context.get("authSession"));
    return context.json(ConfigUpdateGenerationContextSchema.parse({
      ...ConfigUpdateContextSchema.parse(result), generation_rules: CONFIG_UPDATE_GENERATION_RULES,
      configuration_schema: z.toJSONSchema(LocalConfigUpdateConfigurationSchema),
    }));
  });

  // Exact-payload lookup is a scoped read. Never enqueue, re-lint against a
  // newer context, or return the saved private artifact from this endpoint.
  app.post("/v1/config/updates/resolve", async (context) => {
    context.header("cache-control", "no-store");
    context.set("operationStage", "config_resolve");
    const requestBody = await readRequestTextWithinLimit(context.req.raw, MAX_REQUEST_BYTES);
    if (!requestBody.ok) return errorJson(context, 413, "PAYLOAD_TOO_LARGE", "The config update exceeds 132 KiB.");
    let input: unknown;
    try { input = JSON.parse(requestBody.text); } catch { input = null; }
    const body = ConfigUpdateRequestSchema.safeParse(input);
    if (!body.success || !body.data.configuration) return errorJson(context, 400, "INVALID_REQUEST", "Use the exact original update with its local configuration artifact.");
    return context.json(ConfigUpdateStatusSchema.parse(await dependencies.resolveConfigUpdate(context.get("authSession"), body.data)));
  });

  // Registered before `/v1/config/:section` so the literal segment wins.
  app.get("/v1/config/updates/:submission_ref", async (context) => {
    context.set("operationStage", "config_status");
    const ref = SubmissionRefSchema.safeParse(context.req.param("submission_ref"));
    if (!ref.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The config update reference must be a UUID.",
      );
    }
    const result = await dependencies.getConfigUpdateStatus(
      context.get("authSession"),
      ref.data,
    );
    return context.json(ConfigUpdateStatusSchema.parse(result));
  });

  app.get("/v1/config/:section", async (context) => {
    const section = ConfigSectionSchema.safeParse(
      (context.req.param("section") ?? "").toLowerCase(),
    );
    if (!section.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The config section must be one of icp, tone, prompt, workspace.",
      );
    }
    const result = await dependencies.getConfig(context.get("authSession"), section.data);
    return context.json(WorkspaceConfigSchema.parse(result));
  });

  app.patch("/v1/config", async (context) => {
    context.set("operationStage", "config_validate");
    const declaredLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The config update exceeds 132 KiB.",
      );
    }
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_REQUEST_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The config update exceeds 132 KiB.",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const body = ConfigUpdateRequestSchema.safeParse(parsedJson);
    if (!body.success) {
      if (parsedJson && typeof parsedJson === "object" && "configuration" in parsedJson
        && !LocalConfigUpdateConfigurationSchema.safeParse(parsedJson.configuration).success) {
        const lint = lintLocalConfigUpdateConfiguration(parsedJson.configuration, {});
        if (!lint.success) return errorJson(context, 422, "LOCAL_CONFIGURATION_INVALID", "Repair the local update artifact using the published schema.", lint.issues);
      }
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The config update must be {section, values}, {section: \"prompt\", instruction}, or {values}.",
      );
    }

    if (body.data.configuration) {
      context.set("operationStage", "config_context");
      const current = await dependencies.getConfigUpdateContext(context.get("authSession"));
      const request = body.data;
      // A mismatched version can be an exact imported retry. SQL distinguishes
      // that replay from a new stale artifact before any write; validate fresh
      // artifacts against the current snapshot only.
      if (request.configuration?.context_version === current.context_version) {
        const patch = "section" in request ? request.section === "icp" ? request.values : {} : request.values.icp;
        const desiredIcp = { ...current.current_config.config.icp, ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) };
        const lint = lintLocalConfigUpdateConfiguration(request.configuration, desiredIcp, current.scout_global_base);
        if (!lint.success) return errorJson(context, 422, "LOCAL_CONFIGURATION_INVALID", "Repair the local update using these issues and submit it again.", lint.issues.map(issue => ({ ...issue,
          path: issue.path.replace("/desired_icp", "section" in request && request.section === "icp" ? "/values" : "/values/icp"),
      })));
      }
    }

    context.set("operationStage", "config_submit");
    const submission = await dependencies.submitConfigUpdate(
      context.get("authSession"),
      body.data,
    );

    // Simple metadata already landed. Generated configuration is stored as a
    // pending submission; its fields and artifacts publish together at import.
    // Anything flagged for regeneration gets exactly one job; a replay of a
    // still-pending digest re-enqueues idempotently (self-healing a lost
    // enqueue), and a previously failed regeneration gets a fresh run keyed on
    // the requeue stamp, so a lost enqueue after a requeue is also healed.
    let state = submission.state;
    let runRef = submission.run_ref;
    const regenerates = submission.regenerate_icp || submission.regenerate_prompt;
    if (regenerates && submission.import_status !== "imported") {
      let requeuedAt = submission.requeued_at ?? null;
      if (submission.import_status === "failed") {
        // Reset the row before the job runs, so the founder's poll never
        // reads the previous failure while the retry lands behind it.
        context.set("operationStage", "config_requeue");
        const requeued = await dependencies.requeueConfigUpdate(
          context.get("authSession"),
          submission.submission_ref,
        );
        requeuedAt = requeued.state === "none"
          ? new Date().toISOString()
          : requeued.requeued_at ?? new Date().toISOString();
      }
      context.set("operationStage", "config_enqueue");
      await dependencies.enqueueConfigUpdate(submission.submission_ref, { requeuedAt });
      state = "queued";
      runRef = submission.submission_ref;
    }

    // A historical synchronous filter-only receipt can carry a lane version
    // only in readback; preserve that compatible receipt projection.
    let icpVersion = submission.icp_version ?? null;
    if (
      icpVersion === null
      && state !== "queued"
      && submission.artifact_actions.icp === "applied"
    ) {
      context.set("operationStage", "config_readback");
      const config = await dependencies.getConfig(context.get("authSession"), "icp");
      icpVersion = config.config.icp?.version ?? null;
    }

    return context.json(
      ConfigUpdateResultSchema.parse({
        state,
        submission_ref: submission.submission_ref,
        run_ref: runRef,
        import_status: submission.import_status,
        changed_sections: submission.changed_sections,
        artifact_actions: submission.artifact_actions,
        workspace_ref: submission.workspace_ref,
        created: submission.created,
        icp_version: icpVersion,
        prompt_chars: submission.prompt_chars ?? null,
        prompt_version: submission.prompt_version ?? null,
        error_code: state === "queued" ? null : submission.error_code ?? null,
      }),
    );
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

  app.get("/v1/workspaces/:workspace_ref/apollo/recovery/:first_run_ref", async (context) => {
    context.header("cache-control", "no-store");
    const refs = z.object({
      workspace_ref: z.uuid(),
      first_run_ref: z.uuid(),
    }).safeParse(context.req.param());
    if (!refs.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose exact workspace and first-run references.");
    }
    const result = await dependencies.acquisitionRecovery(context.get("authSession"), {
      ...refs.data,
      operation: "status",
    });
    return context.json(AcquisitionRecoveryStatus.parse(result));
  });
  app.post("/v1/workspaces/:workspace_ref/apollo/recovery/:first_run_ref", async (context) => {
    context.header("cache-control", "no-store");
    const refs = z.object({
      workspace_ref: z.uuid(),
      first_run_ref: z.uuid(),
    }).safeParse(context.req.param());
    if (!refs.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose exact workspace and first-run references.");
    }
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) {
      return errorJson(context, 413, "INVALID_REQUEST", "Recovery request is too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return errorJson(context, 400, "INVALID_REQUEST", "Provide one recovery request as JSON.");
    }
    const parsed = AcquisitionRecoveryBody.safeParse(body);
    if (!parsed.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose recovery request or restart with the exact acquisition reference.");
    }
    const result = await dependencies.acquisitionRecovery(context.get("authSession"), {
      ...refs.data,
      ...parsed.data,
    });
    const schema = parsed.data.operation === "restart"
      ? AcquisitionRestartResult
      : AcquisitionRecoveryStatus;
    return context.json(schema.parse(result));
  });

  app.get("/v1/workspaces/:workspace_ref/apollo/allowance", async context => {
    context.header("cache-control","no-store");
    const parsed=z.uuid().safeParse(context.req.param("workspace_ref"));
    if(!parsed.success)return errorJson(context,400,"INVALID_WORKSPACE","Choose a valid workspace ID.");
    return context.json(ApolloAllowanceSchema.parse(await dependencies.getApolloAllowance(context.get("authSession"),parsed.data)));
  });
  app.get("/v1/workspaces/:workspace_ref/integrations/apollo/key-source", async (context) => {
    context.header("cache-control", "no-store");
    const workspace = z.uuid().safeParse(context.req.param("workspace_ref"));
    if (!workspace.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a valid workspace.");
    return context.json(ApolloCredentialResult.parse(await dependencies.apolloCredentials(context.get("authSession"), workspace.data, {operation:"status"})));
  });
  app.post("/v1/workspaces/:workspace_ref/integrations/apollo/key-source", async (context) => {
    context.header("cache-control", "no-store");
    const workspace = z.uuid().safeParse(context.req.param("workspace_ref"));
    if (!workspace.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a valid workspace.");
    const raw = await readRequestTextWithinLimit(context.req.raw, 8192);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Apollo credential request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide one Apollo credential choice as JSON."); }
    const choice = ApolloCredentialChoice.safeParse(body);
    if (!choice.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose platform_default or provide your own Apollo key.");
    return context.json(ApolloCredentialResult.parse(await dependencies.apolloCredentials(context.get("authSession"), workspace.data, choice.data)));
  });

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
