import type { AuthSession } from "./app.js";
import {
  ConfigUpdateStatusSchema,
  type ConfigUpdateStatus,
  ConfigUpdateSubmissionSchema,
  type ConfigUpdateRequest,
  type ConfigUpdateSubmission,
  type ConfigSection,
  CreateWorkspaceResultSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResult,
  DisconnectResultSchema,
  type DisconnectResult,
  OnboardingStatusSchema,
  type OnboardingStatus,
  OnboardingSubmissionSchema,
  type OnboardingSubmission,
  type Provider,
  RunStatusSchema,
  type RunStatus,
  StartRunResultSchema,
  type StartRunResult,
  StartCrmSyncResultSchema,
  type StartCrmSyncResult,
  CrmSyncStatusSchema,
  type CrmSyncStatus,
  WorkspaceConfigSchema,
  type WorkspaceConfig,
  WorkspaceStatusSchema,
  type WorkspaceStatus,
  NotificationConfigSchema,
  type NotificationConfig,
  NotificationDestinationSchema,
  type NotificationDestination,
  NotificationRouteSchema,
  type NotificationRoute,
  NotificationTestResultSchema,
  type NotificationTestResult,
  SetNotificationRouteRequestSchema,
  type SetNotificationRouteRequest,
  SlackNotificationChannelsSchema,
  type SlackNotificationChannels,
  UpsertNotificationDestinationRequestSchema,
  type UpsertNotificationDestinationRequest,
} from "./contracts.js";
import { PublicError } from "./errors.js";

interface RpcClient {
  rpc<T>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: T; error: unknown }>;
}

interface FunctionsClient {
  functions: {
    invoke<T>(
      name: string,
      options?: { method?: "GET" | "POST" },
    ): Promise<{ data: T; error: unknown }>;
  };
}

function getRpcClient(session: AuthSession): RpcClient {
  return session.client as RpcClient;
}

function getFunctionsClient(session: AuthSession): FunctionsClient {
  return session.client as FunctionsClient;
}

function unwrapSingleRow(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function invalidResponse(cause: unknown): PublicError {
  return new PublicError({
    status: 502,
    code: "SUPABASE_INVALID_RESPONSE",
    message: "LIFTY received an invalid workspace response.",
    cause,
  });
}

/** The reason token after a `lifty_config_invalid:` marker, or null. Fixed server vocabulary — safe to surface. */
function configInvalidReason(message: string): string | null {
  const match = /^lifty_config_invalid:\s*([a-z0-9_]{1,80})/.exec(message);
  return match?.[1] ?? null;
}

function mapRpcError(error: unknown): PublicError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";

  if (code === "PT409" && message.includes("lifty_multi_lane_config_unsupported")) {
    return new PublicError({
      status: 409,
      code: "MULTI_LANE_CONFIG_UNSUPPORTED",
      message: "This workspace's ICP lanes are managed outside LIFTY. Use the LIFT admin tools to change lane targeting.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("workspace_already_exists")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_ALREADY_EXISTS",
      message: "This account already has a LIFTY workspace.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_run_not_configured")) {
    return new PublicError({
      status: 409,
      code: "RUN_NOT_CONFIGURED",
      message: "This workspace has no generated configuration yet. Run `lifty push` first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_run_already_completed")) {
    return new PublicError({
      status: 409,
      code: "RUN_ALREADY_COMPLETED",
      message: "The first ICP batch already ran for this workspace. See it with `lifty status`.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_run_workspace_suspended")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_SUSPENDED",
      message: "This workspace is suspended. Contact LIFT support.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_run_unavailable")) {
    return new PublicError({
      status: 409,
      code: "RUN_UNAVAILABLE",
      message: "LIFTY cannot start a run for this workspace right now. Contact LIFT support.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_not_connected")) {
    return new PublicError({
      status: 409,
      code: "HUBSPOT_NOT_CONNECTED",
      message: "No usable HubSpot connection. Connect first with `lifty connect hubspot`.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_nothing_to_sync")) {
    return new PublicError({
      status: 409,
      code: "NOTHING_TO_SYNC",
      message: "Every researched lead is already in your CRM.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_run_in_progress")) {
    return new PublicError({
      status: 409,
      code: "RUN_IN_PROGRESS",
      message: "A lead run is still working. Check it with `lifty status`, then run `lifty sync` again.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_workspace_suspended")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_SUSPENDED",
      message: "This workspace is suspended. Contact LIFT support.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_in_flight")) {
    return new PublicError({
      status: 409,
      code: "SYNC_IN_PROGRESS",
      message: "A CRM sync is still running. Wait for it to finish (`lifty status`), then disconnect.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_integration_not_connected")) {
    return new PublicError({
      status: 409,
      code: "NOT_CONNECTED",
      message: "This provider is not connected to your workspace.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_slack_not_connected")) {
    return new PublicError({
      status: 409,
      code: "SLACK_NOT_CONNECTED",
      message: "Connect Slack before configuring notification channels.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("notification_destination_unavailable")) {
    return new PublicError({
      status: 409,
      code: "DESTINATION_UNAVAILABLE",
      message: "That Slack channel is unavailable. Refresh channels and select it again.",
      cause: error,
    });
  }

  if (code === "PT404" && message.includes("notification_destination_missing")) {
    return new PublicError({
      status: 404,
      code: "DESTINATION_NOT_FOUND",
      message: "That notification destination does not exist in this workspace.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_config_missing_icp")) {
    return new PublicError({
      status: 409,
      code: "CONFIG_NOT_READY",
      message: "This workspace has no generated configuration yet. Run `lifty push` first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_prompt_hand_tuned")) {
    return new PublicError({
      status: 409,
      code: "PROMPT_HAND_TUNED",
      message: "The research prompt for this workspace was hand-tuned by LIFT and is not regenerated automatically. Contact LIFT support to change it.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_MISSING",
      message: "This account has no LIFTY workspace yet. Run `lifty login` first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_config_update_in_flight")) {
    return new PublicError({
      status: 409,
      code: "CONFIG_UPDATE_IN_FLIGHT",
      message: "Another configuration change is still being applied. Check `lifty status` and send this update again once it has landed.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_config_missing_prompt")) {
    return new PublicError({
      status: 409,
      code: "CONFIG_NOT_READY",
      message: "This workspace has no research prompt yet. Run `lifty push` first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_config_update_not_retryable")) {
    return new PublicError({
      status: 409,
      code: "CONFIG_UPDATE_NOT_RETRYABLE",
      message: "That config update is not in a failed state, so there is nothing to retry.",
      cause: error,
    });
  }

  if (code === "PT404" && message.includes("lifty_config_update_missing")) {
    return new PublicError({
      status: 404,
      code: "CONFIG_UPDATE_NOT_FOUND",
      message: "No config update with that reference exists for this workspace.",
      cause: error,
    });
  }

  if (code === "PT401") {
    return new PublicError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "A valid LIFTY session is required.",
      cause: error,
    });
  }

  if (code === "PT400" && message.startsWith("lifty_draft_invalid:")) {
    return new PublicError({
      status: 422,
      code: "DRAFT_INVALID",
      message: "The onboarding draft did not pass server validation.",
      cause: error,
    });
  }

  if (code === "PT400" && message.startsWith("lifty_workspace_invalid:")) {
    return new PublicError({
      status: 422,
      code: "WORKSPACE_INVALID",
      message: "The workspace request did not pass server validation.",
      cause: error,
    });
  }

  if (code === "PT400" && message.startsWith("lifty_config_invalid:")) {
    const reason = configInvalidReason(message);
    return new PublicError({
      status: 422,
      code: "CONFIG_INVALID",
      message: reason
        ? `The config update did not pass server validation (${reason}).`
        : "The config update did not pass server validation.",
      cause: error,
    });
  }

  if (code === "PT400" && message.includes("lifty_provider_invalid")) {
    return new PublicError({
      status: 400,
      code: "PROVIDER_INVALID",
      message: "Unknown provider. Supported providers: hubspot, unipile.",
      cause: error,
    });
  }

  if (code === "PT413" && message.startsWith("lifty_workspace_too_large:")) {
    return new PublicError({
      status: 413,
      code: "WORKSPACE_FIELD_TOO_LARGE",
      message: "The workspace request exceeds the server safety limits.",
      cause: error,
    });
  }

  if (code === "PT413" && message.startsWith("lifty_config_too_large:")) {
    return new PublicError({
      status: 413,
      code: "CONFIG_TOO_LARGE",
      message: "The config update exceeds the server safety limits.",
      cause: error,
    });
  }

  if (code === "PT413") {
    return new PublicError({
      status: 413,
      code: "DRAFT_TOO_LARGE",
      message: "The onboarding draft exceeds the server safety limits.",
      cause: error,
    });
  }

  if (code === "PT409") {
    return new PublicError({
      status: 409,
      code: "PROVISIONING_CONFLICT",
      message: "The workspace could not be provisioned because of a conflict.",
      cause: error,
    });
  }

  // P0001 is a plain `raise exception` — a database trigger or function
  // rejected the request outright rather than failing to run.
  if (code === "P0001") {
    return new PublicError({
      status: 502,
      code: "PROVISIONING_REJECTED",
      message: "A LIFTY server-side integrity check rejected the workspace request. Contact LIFT support.",
      cause: error,
    });
  }

  return new PublicError({
    status: 502,
    code: "SUPABASE_REQUEST_FAILED",
    message: "LIFTY could not complete the workspace request.",
    cause: error,
  });
}

export async function getWorkspaceStatus(
  session: AuthSession,
): Promise<WorkspaceStatus> {
  const client = getRpcClient(session);
  const { data, error } = await client.rpc("get_lifty_workspace_status");

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = WorkspaceStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function createWorkspace(
  session: AuthSession,
  input: CreateWorkspaceRequest,
): Promise<CreateWorkspaceResult> {
  const { data, error } = await getRpcClient(session).rpc<CreateWorkspaceResult>(
    "create_lifty_workspace",
    { name: input.name, description: input.description ?? null },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = CreateWorkspaceResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function submitOnboarding(
  session: AuthSession,
  draft: Record<string, unknown>,
): Promise<OnboardingSubmission> {
  const { data, error } = await getRpcClient(session).rpc<OnboardingSubmission>(
    "submit_lifty_onboarding",
    { draft },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = OnboardingSubmissionSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getOnboardingStatus(
  session: AuthSession,
): Promise<OnboardingStatus> {
  const { data, error } = await getRpcClient(session).rpc<OnboardingStatus>(
    "get_lifty_onboarding_status",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = OnboardingStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function startRun(session: AuthSession): Promise<StartRunResult> {
  const { data, error } = await getRpcClient(session).rpc<StartRunResult>(
    "start_lifty_run",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = StartRunResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getRunStatus(session: AuthSession): Promise<RunStatus> {
  const { data, error } = await getRpcClient(session).rpc<RunStatus>(
    "get_lifty_run_status",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = RunStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function startCrmSyncRun(
  session: AuthSession,
): Promise<StartCrmSyncResult> {
  const { data, error } = await getRpcClient(session).rpc<StartCrmSyncResult>(
    "start_lifty_crm_sync_run",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = StartCrmSyncResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getCrmSyncStatus(
  session: AuthSession,
): Promise<CrmSyncStatus> {
  const { data, error } = await getRpcClient(session).rpc<CrmSyncStatus>(
    "get_lifty_crm_sync_status",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = CrmSyncStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

// ---------------------------------------------------------------- P6 (LIF-669)

/** get_lifty_config: all sections, or one. Secret-free by construction in the RPC. */
export async function getConfig(
  session: AuthSession,
  section: ConfigSection | null,
): Promise<WorkspaceConfig> {
  const { data, error } = await getRpcClient(session).rpc<WorkspaceConfig>(
    "get_lifty_config",
    section ? { section } : undefined,
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = WorkspaceConfigSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

/** submit_lifty_config_update: the P6.1 write seam (digests, routing matrix, synchronous direct writes). */
export async function submitConfigUpdate(
  session: AuthSession,
  payload: ConfigUpdateRequest,
): Promise<ConfigUpdateSubmission> {
  const { data, error } = await getRpcClient(session).rpc<ConfigUpdateSubmission>(
    "submit_lifty_config_update",
    { payload },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = ConfigUpdateSubmissionSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

/** get_lifty_config_update_status: one submission by ref, or the latest when ref is null. */
export async function getConfigUpdateStatus(
  session: AuthSession,
  submissionRef: string | null,
): Promise<ConfigUpdateStatus> {
  const { data, error } = await getRpcClient(session).rpc<ConfigUpdateStatus>(
    "get_lifty_config_update_status",
    submissionRef ? { p_submission_ref: submissionRef } : undefined,
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = ConfigUpdateStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

/**
 * requeue_lifty_config_update: flip the actor's failed submission back to pending
 * before the fresh enqueue, so a poll never reads the stale failure (LIF-672).
 */
export async function requeueConfigUpdate(
  session: AuthSession,
  submissionRef: string,
): Promise<ConfigUpdateStatus> {
  const { data, error } = await getRpcClient(session).rpc<ConfigUpdateStatus>(
    "requeue_lifty_config_update",
    { p_submission_ref: submissionRef },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = ConfigUpdateStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

/** disconnect_lifty_integration: the one destructive founder verb (confirmation is the skill's job). */
export async function disconnectIntegration(
  session: AuthSession,
  provider: Provider,
): Promise<DisconnectResult> {
  const { data, error } = await getRpcClient(session).rpc<DisconnectResult>(
    "disconnect_lifty_integration",
    { p_provider: provider },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = DisconnectResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getNotificationConfig(
  session: AuthSession,
): Promise<NotificationConfig> {
  const { data, error } = await getRpcClient(session).rpc<NotificationConfig>(
    "get_lifty_notification_config",
  );
  if (error) throw mapRpcError(error);
  const parsed = NotificationConfigSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}

export async function listSlackNotificationChannels(
  session: AuthSession,
): Promise<SlackNotificationChannels> {
  const { data, error } = await getFunctionsClient(session).functions.invoke<unknown>(
    "lifty-slack-channels",
    { method: "POST" },
  );
  if (error) {
    throw new PublicError({
      status: 502,
      code: "SLACK_CHANNELS_UNAVAILABLE",
      message: "LIFTY could not load Slack channels. Try again in a moment.",
      cause: error,
    });
  }
  const parsed = SlackNotificationChannelsSchema.safeParse(data);
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}

export async function upsertNotificationDestination(
  session: AuthSession,
  input: UpsertNotificationDestinationRequest,
): Promise<NotificationDestination> {
  const validated = UpsertNotificationDestinationRequestSchema.parse(input);
  const { data, error } = await getRpcClient(session).rpc<NotificationDestination>(
    "upsert_lifty_notification_destination",
    {
      p_external_id: validated.channel_id,
      p_display_name: validated.channel_name,
    },
  );
  if (error) throw mapRpcError(error);
  const parsed = NotificationDestinationSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}

export async function setNotificationRoute(
  session: AuthSession,
  input: SetNotificationRouteRequest,
): Promise<NotificationRoute> {
  const validated = SetNotificationRouteRequestSchema.parse(input);
  const { data, error } = await getRpcClient(session).rpc<NotificationRoute>(
    "set_lifty_notification_route",
    {
      p_notification_type: validated.notification_type,
      p_destination_id: validated.destination_ref,
      p_enabled: validated.enabled,
    },
  );
  if (error) throw mapRpcError(error);
  const parsed = NotificationRouteSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}

export async function enqueueNotificationTest(
  session: AuthSession,
  destinationRef: string,
): Promise<NotificationTestResult> {
  const { data, error } = await getRpcClient(session).rpc<NotificationTestResult>(
    "enqueue_lifty_notification_test",
    { p_destination_id: destinationRef },
  );
  if (error) throw mapRpcError(error);
  const parsed = NotificationTestResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}
