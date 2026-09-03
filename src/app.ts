import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  ConfigSectionSchema,
  ConfigUpdateRequestSchema,
  ConfigUpdateResultSchema,
  ConfigUpdateStatusSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResultSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResult,
  DisconnectResultSchema,
  HubspotConnectStartSchema,
  IntegrationConnectionStatusSchema,
  OnboardingPushResultSchema,
  OnboardingStatusSchema,
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
  type OnboardingStatus,
  type OnboardingSubmission,
  type Provider,
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
  EnqueueOnboardingImport,
} from "./trigger-client.js";
import { PublicError } from "./errors.js";
import {
  HubspotCallbackError,
  type HubspotCallbackSuccess,
} from "./hubspot-connect.js";
import { isSealedHubspotState } from "./hubspot-state.js";

const MAX_REQUEST_BYTES = 132 * 1024;
// The create-workspace body carries only a bounded name and description.
const MAX_CREATE_WORKSPACE_BYTES = 16 * 1024;
const RequestIdSchema = z.uuid();
const SubmissionRefSchema = z.uuid();

export interface AuthSession {
  userId: string;
  client: unknown;
}

export type AuthenticationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "invalid_session" };

export type { OnboardingPushResult, WorkspaceStatus } from "./contracts.js";

export interface AppDependencies {
  authenticate(request: Request): Promise<AuthenticationResult>;
  getWorkspace(session: AuthSession): Promise<WorkspaceStatus>;
  createWorkspace(
    session: AuthSession,
    input: CreateWorkspaceRequest,
  ): Promise<CreateWorkspaceResult>;
  submitOnboarding(
    session: AuthSession,
    draft: Record<string, unknown>,
  ): Promise<OnboardingSubmission>;
  getOnboardingStatus(session: AuthSession): Promise<OnboardingStatus>;
  enqueueOnboardingImport: EnqueueOnboardingImport;
  startRun(session: AuthSession): Promise<StartRunResult>;
  getRunStatus(session: AuthSession): Promise<RunStatus>;
  enqueueFirstRun: EnqueueFirstRun;
  startCrmSyncRun(session: AuthSession): Promise<StartCrmSyncResult>;
  getCrmSyncStatus(session: AuthSession): Promise<CrmSyncStatus>;
  enqueueCrmSync: EnqueueCrmSync;
  getConfig(session: AuthSession, section: ConfigSection | null): Promise<WorkspaceConfig>;
  submitConfigUpdate(
    session: AuthSession,
    payload: ConfigUpdateRequest,
  ): Promise<ConfigUpdateSubmission>;
  getConfigUpdateStatus(
    session: AuthSession,
    submissionRef: string | null,
  ): Promise<ConfigUpdateStatus>;
  enqueueConfigUpdate: EnqueueConfigUpdate;
  requeueConfigUpdate(session: AuthSession, submissionRef: string): Promise<ConfigUpdateStatus>;
  disconnectIntegration(session: AuthSession, provider: Provider): Promise<DisconnectResult>;
  startHubspotConnect(session: AuthSession): Promise<HubspotConnectStart>;
  getHubspotConnection(session: AuthSession): Promise<HubspotConnectionStatus>;
  completeHubspotCallback(
    input: { code: string; state: string },
  ): Promise<HubspotCallbackSuccess>;
  buildHubspotAuthorizeUrl(state: string): string | null;
  renderCliAuthPage(
    state: string,
    port: number,
  ): {
    html: string;
    scriptNonce: string;
    connectOrigin?: string;
  } | null;
  checkReadiness(): Promise<boolean>;
  log(event: LogEvent): void;
}

export interface LogEvent {
  level: "warn" | "error";
  event: "request_failed";
  request_id: string;
  method: string;
  path: string;
  error_code: string;
  status: number;
}

type AppEnvironment = {
  Variables: {
    requestId: string;
    authSession: AuthSession;
  };
};

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
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
      409: JsonResponse(ErrorResponseSchema),
      413: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
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
    responses: {
      200: JsonResponse(StartRunResultSchema),
      401: JsonResponse(ErrorResponseSchema),
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
      200: JsonResponse(HubspotConnectStartSchema),
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
      200: JsonResponse(DisconnectResultSchema),
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
      <p class="hint">You can close this tab and return to your terminal.</p>
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
): Response {
  return context.json(
    { error: { code, message }, request_id: context.get("requestId") },
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
        "Unknown provider. Supported providers: hubspot, unipile.",
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
  getCrmSyncStatus: async () => {
    throw new Error("getCrmSyncStatus is not configured");
  },
  enqueueCrmSync: async () => {
    throw new Error("enqueueCrmSync is not configured");
  },
  getConfig: async () => {
    throw new Error("getConfig is not configured");
  },
  submitConfigUpdate: async () => {
    throw new Error("submitConfigUpdate is not configured");
  },
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
  renderCliAuthPage: () => null,
  checkReadiness: async () => true,
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
};

export function createApp(
  overrides: Partial<AppDependencies> = {},
): OpenAPIHono<AppEnvironment> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const app = new OpenAPIHono<AppEnvironment>();
  registerOpenApi(app);

  app.use("*", async (context, next) => {
    const suppliedRequestId = RequestIdSchema.safeParse(
      context.req.header("x-request-id"),
    );
    const requestId = suppliedRequestId.success
      ? suppliedRequestId.data
      : crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
  });

  app.get("/healthz", (context) => context.json({ status: "ok" }));
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
      return hubspotHtmlResponse(
        context,
        400,
        "HubSpot authorization was cancelled",
        "No connection was saved. Ask LIFTY for a fresh link when you are ready.",
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
    });
    return context.json(
      {
        error: { code: publicError.code, message: publicError.message },
        request_id: context.get("requestId"),
      },
      publicError.status as ContentfulStatusCode,
    );
  });

  app.use("/v1/*", async (context, next) => {
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

  // ---------------------------------------------------------------- status

  // One aggregate read so `lifty status` answers "is my HubSpot OK?" without
  // ever touching OAuth: workspace, onboarding import, first run, the latest
  // config update, and per-provider connection + last sync.
  app.get("/v1/status", async (context) => {
    const session = context.get("authSession");
    const workspace = await dependencies.getWorkspace(session);
    if (workspace.state === "needs_workspace") {
      return context.json(
        WorkspaceOverviewSchema.parse({
          workspace: { state: "needs_workspace" },
          onboarding: { state: "none" },
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

    const [onboarding, run, sync, hubspot, configUpdate] = await Promise.all([
      dependencies.getOnboardingStatus(session),
      dependencies.getRunStatus(session),
      dependencies.getCrmSyncStatus(session),
      dependencies.getHubspotConnection(session),
      dependencies.getConfigUpdateStatus(session, null),
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
          unipile: { available: false, connected: false },
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
    const body = SubmitOnboardingRequestSchema.safeParse(parsedJson);
    if (!body.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The onboarding push must contain one JSON object named draft.",
      );
    }

    const submission = await dependencies.submitOnboarding(
      context.get("authSession"),
      body.data.draft,
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

  app.get("/v1/onboarding", async (context) => {
    const result = await dependencies.getOnboardingStatus(
      context.get("authSession"),
    );
    return context.json(OnboardingStatusSchema.parse(result));
  });

  app.post("/v1/workspace/runs", async (context) => {
    const result = await dependencies.startRun(context.get("authSession"));
    // Enqueue on every start, including a re-attach: the run-scoped
    // idempotency key makes it a no-op when the run is already enqueued and
    // self-heals an enqueue lost after the ledger insert.
    await dependencies.enqueueFirstRun(result.run_ref);
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

  // Registered before `/v1/config/:section` so the literal segment wins.
  app.get("/v1/config/updates/:submission_ref", async (context) => {
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
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The config update must be {section, values}, {section: \"prompt\", instruction}, or {values}.",
      );
    }

    const submission = await dependencies.submitConfigUpdate(
      context.get("authSession"),
      body.data,
    );

    // Direct writes (filters, tone, workspace) already landed inside the RPC.
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
        const requeued = await dependencies.requeueConfigUpdate(
          context.get("authSession"),
          submission.submission_ref,
        );
        requeuedAt = requeued.state === "none"
          ? new Date().toISOString()
          : requeued.requeued_at ?? new Date().toISOString();
      }
      await dependencies.enqueueConfigUpdate(submission.submission_ref, { requeuedAt });
      state = "queued";
      runRef = submission.submission_ref;
    }

    // A synchronous filter-only write lands a new lane version inside the RPC
    // but its receipt carries no version; read it back so the CLI can name it.
    let icpVersion = submission.icp_version ?? null;
    if (
      icpVersion === null
      && state !== "queued"
      && submission.artifact_actions.icp === "applied"
    ) {
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

  // ---------------------------------------------------------------- integrations

  app.post("/v1/integrations/:provider/connect", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider !== "hubspot") {
      return providerUnavailable(context, provider.provider);
    }
    const result = await dependencies.startHubspotConnect(
      context.get("authSession"),
    );
    return context.json(HubspotConnectStartSchema.parse(result));
  });

  app.get("/v1/integrations/:provider", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider !== "hubspot") {
      // No connect path exists yet, so nothing can be connected.
      return context.json(
        IntegrationConnectionStatusSchema.parse({
          provider: provider.provider,
          status: "not_connected",
        }),
      );
    }
    const result = await dependencies.getHubspotConnection(
      context.get("authSession"),
    );
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
    return context.json(DisconnectResultSchema.parse(result));
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
