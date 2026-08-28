import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  ProvisionRequestSchema,
  ProvisioningResultSchema,
  type ProvisioningResult,
  WorkspaceStatusSchema,
  type WorkspaceStatus,
} from "./contracts.js";
import { PublicError } from "./errors.js";

const MAX_REQUEST_BYTES = 132 * 1024;

export interface AuthSession {
  userId: string;
  client: unknown;
}

export type AuthenticationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "invalid_session" };

export type { ProvisioningResult, WorkspaceStatus } from "./contracts.js";

export interface AppDependencies {
  authenticate(request: Request): Promise<AuthenticationResult>;
  getWorkspace(session: AuthSession): Promise<WorkspaceStatus>;
  provisionWorkspace(
    session: AuthSession,
    draft: Record<string, unknown>,
  ): Promise<ProvisioningResult>;
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
    responses: { 200: JsonResponse(z.object({ status: z.literal("ready") })) },
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
    path: "/v1/workspaces",
    operationId: "provisionWorkspace",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ProvisionRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(ProvisioningResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      413: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
}

const defaultDependencies: AppDependencies = {
  authenticate: async () => ({ ok: false, reason: "invalid_session" }),
  getWorkspace: async () => {
    throw new Error("getWorkspace is not configured");
  },
  provisionWorkspace: async () => {
    throw new Error("provisionWorkspace is not configured");
  },
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
};

export function createApp(
  overrides: Partial<AppDependencies> = {},
): OpenAPIHono<AppEnvironment> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const app = new OpenAPIHono<AppEnvironment>();
  registerOpenApi(app);

  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
  });

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ready" }));
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
    return context.json(await dependencies.getWorkspace(context.get("authSession")));
  });

  app.post("/v1/workspaces", async (context) => {
    const declaredLength = Number(context.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The provisioning request exceeds 132 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
      );
    }
    const requestText = await context.req.text();
    if (new TextEncoder().encode(requestText).byteLength > MAX_REQUEST_BYTES) {
      return context.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The provisioning request exceeds 132 KiB.",
          },
          request_id: context.get("requestId"),
        },
        413,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestText);
    } catch {
      parsedJson = null;
    }
    const body = ProvisionRequestSchema.safeParse(parsedJson);
    if (!body.success) {
      return context.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "The provisioning request must contain one JSON object named draft.",
          },
          request_id: context.get("requestId"),
        },
        400,
      );
    }

    return context.json(
      await dependencies.provisionWorkspace(context.get("authSession"), body.data.draft),
    );
  });

  return app;
}
