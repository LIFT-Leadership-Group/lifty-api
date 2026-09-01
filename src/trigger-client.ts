import { PublicError } from "./errors.js";

// Port of the monorepo's canonical Trigger.dev REST shim
// (lift-supabase-functions/_shared/trigger-task.ts): the ingress passes only
// the payload and an idempotency key — queue, retry, and version selection
// belong to the deployed lift-gtm-jobs task.
const ONBOARDING_IMPORT_TASK_ID = "lifty-onboarding-import";
const FIRST_RUN_TASK_ID = "lifty-first-run";
const IDEMPOTENCY_TTL = "1h";

export interface TriggerClientSettings {
  apiUrl: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}

export interface EnqueueOnboardingImportOptions {
  /** A failed import must not dedupe onto its dead run — force a fresh one. */
  fresh: boolean;
}

export type EnqueueOnboardingImport = (
  submissionId: string,
  options: EnqueueOnboardingImportOptions,
) => Promise<{ id: string }>;

async function triggerTask(
  settings: TriggerClientSettings,
  taskId: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ id: string }> {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const baseUrl = settings.apiUrl.replace(/\/$/, "");

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/tasks/${taskId}/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload,
        options: { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_TTL },
      }),
    });
  } catch (error) {
    throw enqueueFailed(error);
  }
  if (!response.ok) {
    throw enqueueFailed(new Error(`Trigger.dev responded ${response.status}`));
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: unknown }
    | null;
  if (!body || typeof body.id !== "string" || body.id.length === 0) {
    throw enqueueFailed(new Error("Trigger.dev returned no run id"));
  }
  return { id: body.id };
}

export function createOnboardingImportTrigger(
  settings: TriggerClientSettings,
): EnqueueOnboardingImport {
  return async (submissionId, options) => {
    const idempotencyKey = options.fresh
      ? `${ONBOARDING_IMPORT_TASK_ID}:${submissionId}:retry:${Date.now()}`
      : `${ONBOARDING_IMPORT_TASK_ID}:${submissionId}`;
    return triggerTask(
      settings,
      ONBOARDING_IMPORT_TASK_ID,
      { submissionId },
      idempotencyKey,
    );
  };
}

export type EnqueueFirstRun = (runId: string) => Promise<{ id: string }>;

export function createFirstRunTrigger(
  settings: TriggerClientSettings,
): EnqueueFirstRun {
  // Always the same key per ledger run: a re-attached `lifty run` re-triggers
  // idempotently, which also self-heals an enqueue lost after the RPC insert.
  return async (runId) =>
    triggerTask(settings, FIRST_RUN_TASK_ID, { runId }, `${FIRST_RUN_TASK_ID}:${runId}`);
}

function enqueueFailed(cause: unknown): PublicError {
  return new PublicError({
    status: 502,
    code: "IMPORT_ENQUEUE_FAILED",
    message:
      "LIFTY accepted the request but could not start the background run. Try the command again.",
    cause,
  });
}
