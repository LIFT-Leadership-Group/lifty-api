import { z } from "zod";
import type { AuthSession } from "./app.js";
import type { EnqueueFirstRun } from "./trigger-client.js";
import { PublicError } from "./errors.js";

export const AcquisitionRecoveryBody = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({
    operation: z.literal("request"),
    expected_acquisition_ref: z.uuid(),
  }).strict(),
  z.object({
    operation: z.literal("restart"),
    expected_acquisition_ref: z.uuid(),
  }).strict(),
]);

export const AcquisitionBlocker = z.enum([
  "first_run_not_failed",
  "terminal_proof_required",
  "active_candidates",
  "workspace_suspended",
  "acquisition_stale",
  "trigger_unavailable",
  "trigger_not_terminal",
  "trigger_graph_invalid",
  "trigger_graph_changed",
  "trigger_identity_mismatch",
]);

const identity = {
  workspace_ref: z.uuid(),
  first_run_ref: z.uuid(),
  current_acquisition_ref: z.uuid(),
  all_acquisition_refs: z.array(z.uuid()).min(1),
  attempt: z.number().int().nonnegative(),
};

export const AcquisitionRecoveryStatus = z.object({
  ...identity,
  can_restart: z.boolean(),
  blocker: AcquisitionBlocker.nullable(),
  recovery_ref: z.uuid().nullable(),
  recovery_state: z.enum(["queued", "checking", "blocked", "verified"]).nullable(),
}).strict().refine((value) =>
  value.can_restart === (value.blocker === null)
  && (value.recovery_ref === null) === (value.recovery_state === null)
  && (!value.can_restart || (value.recovery_state === "verified" && value.recovery_ref !== null)),
);

export const AcquisitionRestartResult = z.object({
  ...identity,
  previous_acquisition_ref: z.uuid(),
  state: z.literal("queued"),
}).strict();

export type AcquisitionRecoveryChoice = z.infer<typeof AcquisitionRecoveryBody>;
export type AcquisitionRecoveryInput = AcquisitionRecoveryChoice & {
  workspace_ref: string;
  first_run_ref: string;
};
export type AcquisitionRecoveryOutput =
  | z.infer<typeof AcquisitionRecoveryStatus>
  | z.infer<typeof AcquisitionRestartResult>;
export type EnqueueAcquisitionVerification = (recoveryRef: string) => Promise<{ id: string }>;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
};

const messages: Record<string, string> = {
  unauthenticated: "Sign in to LIFTY before recovering acquisition.",
  acquisition_forbidden: "Choose a first run from the selected workspace that you belong to.",
  acquisition_stale: "The acquisition changed. Read recovery status and use its exact current reference.",
  acquisition_parent_history_incomplete: "Earlier task attempts cannot be verified completely. Contact LIFT support; this acquisition remains blocked.",
  acquisition_not_recoverable: "This first run has no failed acquisition that can be verified for recovery.",
  acquisition_in_progress: "Acquisition work is still active. It must finish before a restart can be verified.",
  recovery_restart_required: "This acquisition has ended. Use the explicit recovery restart with its current reference.",
};

function failed(error: unknown): never {
  const parsed = z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }).safeParse(error);
  const code = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(messages, code);
  const status = known && parsed.success && /^PT(401|403|409)$/.test(parsed.data.code ?? "")
    ? Number(parsed.data.code!.slice(2))
    : 502;
  throw new PublicError({
    status,
    code: known ? code.toUpperCase() : "ACQUISITION_RECOVERY_UNAVAILABLE",
    message: known
      ? messages[code]!
      : "LIFTY could not confirm acquisition recovery. Retry the same exact references; no new acquisition is chosen automatically.",
  });
}

async function enqueueDurable(work: () => Promise<{ id: string }>): Promise<void> {
  try {
    await work();
  } catch {
    throw new PublicError({
      status: 502,
      code: "ACQUISITION_ENQUEUE_FAILED",
      message: "The recovery request is saved, but its background wakeup was not confirmed. Retry the same exact command and references.",
    });
  }
}

export function createAcquisitionRecoveryOperations(deps: {
  enqueueVerification: EnqueueAcquisitionVerification;
  enqueueFirstRun: EnqueueFirstRun;
}) {
  return async (
    session: AuthSession,
    input: AcquisitionRecoveryInput,
  ): Promise<AcquisitionRecoveryOutput> => {
    const workspace = z.uuid().parse(input.workspace_ref);
    const firstRun = z.uuid().parse(input.first_run_ref);
    const { workspace_ref: _workspace, first_run_ref: _firstRun, ...body } = input;
    const choice = AcquisitionRecoveryBody.parse(body);
    const client = session.client as RpcClient;
    const rpcName = choice.operation === "status"
      ? "get_lifty_acquisition_status"
      : choice.operation === "request"
        ? "request_lifty_acquisition_recovery"
        : "restart_lifty_acquisition";

    let response;
    try {
      response = await client.rpc(rpcName, {
        p_workspace_id: workspace,
        p_first_run_id: firstRun,
        ...(choice.operation === "status"
          ? {}
          : { p_expected_acquisition_ref: choice.expected_acquisition_ref }),
      });
    } catch {
      failed(null);
    }
    if (response.error) failed(response.error);

    const schema = choice.operation === "restart"
      ? AcquisitionRestartResult
      : AcquisitionRecoveryStatus;
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) failed(null);
    const result = parsed.data;
    if (
      result.workspace_ref !== workspace
      || result.first_run_ref !== firstRun
      || !result.all_acquisition_refs.includes(firstRun)
      || !result.all_acquisition_refs.includes(result.current_acquisition_ref)
      || new Set(result.all_acquisition_refs).size !== result.all_acquisition_refs.length
    ) failed(null);

    if (choice.operation === "restart") {
      if (
        !("previous_acquisition_ref" in result)
        || result.previous_acquisition_ref !== choice.expected_acquisition_ref
        || result.current_acquisition_ref === result.previous_acquisition_ref
        || !result.all_acquisition_refs.includes(result.previous_acquisition_ref)
      ) failed(null);

      // The queued attempt is durable. A failed wakeup never chooses another
      // identity; an exact request replay reuses this same attempt and key.
      await enqueueDurable(() => deps.enqueueFirstRun(result.first_run_ref, result.attempt));
    } else if (choice.operation === "request") {
      if (
        result.current_acquisition_ref !== choice.expected_acquisition_ref
        || !("recovery_ref" in result)
        || !result.recovery_ref
      ) failed(null);

      if (result.recovery_state === "queued" || result.recovery_state === "checking") {
        await enqueueDurable(() => deps.enqueueVerification(result.recovery_ref!));
      }
    }
    return result;
  };
}
