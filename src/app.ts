import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResultSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResult,
  HubspotConnectStartSchema,
  HubspotConnectionStatusSchema,
  OnboardingPushResultSchema,
  OnboardingStatusSchema,
  RunStatusSchema,
  StartRunResultSchema,
  SubmitOnboardingRequestSchema,
  type HubspotConnectStart,
  type HubspotConnectionStatus,
  type OnboardingStatus,
  type OnboardingSubmission,
  type RunStatus,
  type StartRunResult,
  WorkspaceStatusSchema,
  type WorkspaceStatus,
} from "./contracts.js";
import type { EnqueueFirstRun, EnqueueOnboardingImport } from "./trigger-client.js";
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
    method: "post",
    path: "/v1/integrations/hubspot/connect",
    operationId: "startHubspotConnect",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(HubspotConnectStartSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/hubspot",
    operationId: "getHubspotConnection",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(HubspotConnectionStatusSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
}

function hubspotPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p><p>You can close this tab and return to your terminal.</p></main></body></html>`;
}

function hubspotHtmlResponse(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  title: string,
  message: string,
): Response {
  return context.html(hubspotPage(title, message), status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
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
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The workspace request exceeds 16 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
      );
    }
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The workspace request exceeds 16 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
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
      return context.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "The workspace request must contain a non-empty name and an optional description.",
          },
          request_id: context.get("requestId"),
        },
        400,
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
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The onboarding push exceeds 132 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
      );
    }
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_REQUEST_BYTES,
    );
    if (!requestBody.ok) {
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The onboarding push exceeds 132 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
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
      return context.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "The onboarding push must contain one JSON object named draft.",
          },
          request_id: context.get("requestId"),
        },
        400,
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

  app.post("/v1/integrations/hubspot/connect", async (context) => {
    const result = await dependencies.startHubspotConnect(
      context.get("authSession"),
    );
    return context.json(HubspotConnectStartSchema.parse(result));
  });

  app.get("/v1/integrations/hubspot", async (context) => {
    const result = await dependencies.getHubspotConnection(
      context.get("authSession"),
    );
    return context.json(HubspotConnectionStatusSchema.parse(result));
  });

  return app;
}
