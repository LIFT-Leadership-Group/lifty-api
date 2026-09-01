import type { AuthSession } from "./app.js";
import {
  CreateWorkspaceResultSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResult,
  ProvisioningResultSchema,
  type ProvisioningResult,
  WorkspaceStatusSchema,
  type WorkspaceStatus,
} from "./contracts.js";
import { PublicError } from "./errors.js";

interface RpcClient {
  rpc<T>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: T; error: unknown }>;
}

function getRpcClient(session: AuthSession): RpcClient {
  return session.client as RpcClient;
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

  if (code === "PT409" && message.includes("workspace_already_exists")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_ALREADY_EXISTS",
      message: "This account already has a LIFTY workspace.",
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

  if (code === "PT413" && message.startsWith("lifty_workspace_too_large:")) {
    return new PublicError({
      status: 413,
      code: "WORKSPACE_FIELD_TOO_LARGE",
      message: "The workspace request exceeds the server safety limits.",
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

export async function provisionWorkspace(
  session: AuthSession,
  draft: Record<string, unknown>,
): Promise<ProvisioningResult> {
  const { data, error } = await getRpcClient(session).rpc<ProvisioningResult>(
    "provision_lifty_workspace",
    { draft },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = ProvisioningResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}
