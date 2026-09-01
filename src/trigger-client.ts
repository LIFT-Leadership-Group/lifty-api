import { PublicError } from "./errors.js";

// Port of the monorepo's canonical Trigger.dev REST shim
// (lift-supabase-functions/_shared/trigger-task.ts): the ingress passes only
// the payload and an idempotency key — queue, retry, and version selection
// belong to the deployed lift-gtm-jobs task.
const ONBOARDING_IMPORT_TASK_ID = "lifty-onboarding-import";
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

export function createOnboardingImportTrigger(
  settings: TriggerClientSettings,
): EnqueueOnboardingImport {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const baseUrl = settings.apiUrl.replace(/\/$/, "");

  return async (submissionId, options) => {
    const idempotencyKey = options.fresh
      ? `${ONBOARDING_IMPORT_TASK_ID}:${submissionId}:retry:${Date.now()}`
      : `${ONBOARDING_IMPORT_TASK_ID}:${submissionId}`;

    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/api/v1/tasks/${ONBOARDING_IMPORT_TASK_ID}/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payload: { submissionId },
            options: { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_TTL },
          }),
        },
      );
    } catch (error) {
      throw enqueueFailed(error);
    }
    if (!response.ok) {
      throw enqueueFailed(
        new Error(`Trigger.dev responded ${response.status}`),
      );
    }

    const body = (await response.json().catch(() => null)) as
      | { id?: unknown }
      | null;
    if (!body || typeof body.id !== "string" || body.id.length === 0) {
      throw enqueueFailed(new Error("Trigger.dev returned no run id"));
    }
    return { id: body.id };
  };
}

function enqueueFailed(cause: unknown): PublicError {
  return new PublicError({
    status: 502,
    code: "IMPORT_ENQUEUE_FAILED",
    message:
      "LIFTY accepted the draft but could not start the import. Run `lifty push` again.",
    cause,
  });
}
