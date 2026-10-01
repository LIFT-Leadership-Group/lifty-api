
import type { AuthSession } from "./app.js";
import { DisconnectResultSchema, type DisconnectResult, type Provider, RunStatusSchema, type RunStatus, StartRunResultSchema, type StartRunResult, StartCrmSyncResultSchema, type StartCrmSyncResult, CrmSyncStatusSchema, type CrmSyncStatus, WorkspaceStatusSchema, type WorkspaceStatus, NotificationConfigSchema, type NotificationConfig, NotificationDestinationSchema, type NotificationDestination, NotificationRouteSchema, type NotificationRoute, NotificationTestResultSchema, type NotificationTestResult, SetNotificationRouteRequestSchema, type SetNotificationRouteRequest, SlackNotificationChannelsSchema, type SlackNotificationChannels, UpsertNotificationDestinationRequestSchema, type UpsertNotificationDestinationRequest } from "./contracts.js";
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

function mapRpcError(error: unknown): PublicError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (code === "PT409" && message.includes("lifty_workspace_ambiguous")) {
    return new PublicError({ status: 409, code: "WORKSPACE_SELECTION_REQUIRED",
      message: "You belong to several workspaces. Choose one with the x-lifty-workspace header (--workspace in the CLI).", cause: error });
  }
  if (code === "PT403" && message.includes("lifty_workspace_forbidden")) {
    return new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN",
      message: "You don't belong to that workspace. Run whoami to list yours.", cause: error });
  }
  if (code === "PT409" && message.includes("lifty_workspace_suspended")) {
    return new PublicError({ status: 409, code: "WORKSPACE_SUSPENDED",
      message: "This workspace is suspended. Contact LIFT support.", cause: error });
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
      message: "This workspace has no configuration yet. Complete Business setup first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_run_already_completed")) {
    return new PublicError({
      status: 409,
      code: "RUN_ALREADY_COMPLETED",
      message: "The first research run already exists for this workspace. Read its status instead of starting another.",
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
      message: "HubSpot is not connected to this workspace. Connect HubSpot first.",
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
      message: "A research run is still in progress. Wait for it to finish, then start the CRM sync again.",
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
      message: "A CRM sync is still running. Wait for it to finish, then disconnect.",
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

  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_MISSING",
      message: "This account has no Lifty workspace yet. Create the workspace first.",
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

  if (code === "PT400" && message.includes("lifty_provider_invalid")) {
    return new PublicError({
      status: 400,
      code: "PROVIDER_INVALID",
      message: "Unknown provider. Supported providers: hubspot, unipile, slack.",
      cause: error,
    });
  }

  if (code === "PT413") {
    return new PublicError({
      status: 413,
      code: "DRAFT_TOO_LARGE",
      message: "The request exceeds the server safety limits.",
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

export async function getRunStatus(session: AuthSession, dashboardOrigin = "https://liftygtm.com"): Promise<RunStatus> {
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
  if (parsed.data.state === "none" || parsed.data.leads === null) return parsed.data;
  return {...parsed.data, leads: parsed.data.leads.map(lead => ({
    ...lead,
    research_url: lead.research_available === true && lead.lead_ref
      ? `${dashboardOrigin}/protected/leads/${lead.lead_ref}` : null,
  }))};
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

// Keep raw PostgREST messages/details in the cause only. They can contain user
// data or SQL; logs get a bounded code and a static operation name instead.
function configRpcError(error: unknown, operation: string): PublicError {
  const mapped = mapRpcError(error);
  const candidate = error && typeof error === "object" && "code" in error ? error.code : null;
  const code = typeof candidate === "string" && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(candidate) ? candidate : undefined;
  return new PublicError({ status: mapped.status, code: mapped.code, message: mapped.message, cause: error,
    diagnostics: { upstream_operation: operation, ...(code ? { upstream_code: code } : {}),
      upstream_kind: code === "XX001" ? "database_storage" : code === "57014" ? "database_timeout" : code ? "database_error" : "transport" },
  });
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
    // The function reports a missing or stale Slack grant as 409. That is a
    // setup step for the founder, not a transient failure to retry.
    // Read the response structurally: the client's Response may come from a
    // different fetch implementation, so instanceof is not reliable here.
    const response = (error as { context?: { status?: unknown; json?: () => Promise<unknown> } }).context;
    if (response?.status === 409) {
      let reason: unknown;
      try { reason = typeof response.json === "function" ? ((await response.json()) as { error?: unknown } | null)?.error : undefined; } catch { reason = undefined; }
      if (reason === "slack_reconnect_required") {
        throw new PublicError({ status: 409, code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack before choosing a notification channel.", cause: error });
      }
      // Every 409 from this function is a Slack setup state, never a transient failure.
      throw new PublicError({ status: 409, code: "SLACK_NOT_CONNECTED", message: "Slack is not connected to this workspace. Connect Slack first.", cause: error });
    }
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
