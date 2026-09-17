import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

const Cursor = z.string().regex(/^rp1_[a-f0-9]{64}$/);
export const RunProgressQuerySchema = z.object({
  run_ref: z.uuid(), cursor: Cursor.optional(),
  wait_seconds: z.coerce.number().int().min(0).max(25).default(25),
}).strict();
const Lead = z.object({
  lead_ref: z.uuid(), name: z.string(), company: z.string().nullable(),
  research_available: z.boolean(), tier: z.string().nullable(),
  fit_rationale: z.string().nullable(), linkedin_url: z.string().nullable(),
}).strict();
export const RunProgressSnapshotSchema = z.object({
  run_ref: z.uuid(), attempt: z.number().int().nonnegative(), workspace_ref: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  requested_leads: z.number().int().min(1).max(25),
  leads_discovered: z.number().int().nonnegative(), leads_researched: z.number().int().min(0).max(25),
  error_code: z.enum(["calibration_sample_incomplete", "calibration_review_required", "research_failed"]).nullable(),
  leads: z.array(Lead).max(25),
}).strict();
export const RunProgressSchema = RunProgressSnapshotSchema.extend({
  cursor: Cursor, changed: z.boolean(), terminal: z.boolean(),
});
export type RunProgressQuery = z.infer<typeof RunProgressQuerySchema>;
export type RunProgress = z.infer<typeof RunProgressSchema>;
interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
function failure(error: unknown): PublicError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "PT401" || code === "PGRST301" || code === "PGRST303") return new PublicError({
    status: 401, code: "UNAUTHORIZED", message: "A valid Lifty session is required.", cause: error,
  });
  if (code === "PT404") return new PublicError({
    status: 404, code: "RUN_NOT_FOUND", message: "This research run is unavailable in your current workspace.", cause: error,
  });
  if (code === "PT409") return new PublicError({
    status: 409, code: "RUN_PROGRESS_UNAVAILABLE", message: "Research progress is unavailable for the current workspace or cohort.", cause: error,
  });
  return new PublicError({ status: 502, code: "RUN_PROGRESS_UNAVAILABLE",
    message: "Research progress could not be read. Retry the same run and cursor.", cause: error });
}

/** A complete current snapshot, not a replay log. No state or history is cached:
 * every poll repeats the authenticated RPC's current workspace/run checks. */
export function createRunProgressReader() {
  const activeUsers = new Set<string>();
  return async (session: AuthSession, query: RunProgressQuery, cancellation: AbortSignal): Promise<RunProgress> => {
    const input = RunProgressQuerySchema.parse(query);
    if (activeUsers.has(session.userId) || activeUsers.size >= 64) throw new PublicError({
      status: 429, code: "RUN_PROGRESS_BUSY", message: "Keep one research progress request open at a time, then retry with the same cursor.",
    });
    activeUsers.add(session.userId);
    // Bound even a stalled RPC; requests remain comfortably inside the CLI's
    // 60-second deadline. AbortSignal reaches PostgREST and the inter-read wait.
    // Leave three seconds for the last database read inside a hard 25s cap.
    const deadline = Date.now() + Math.min(input.wait_seconds * 1000, 22_000);
    const timeout = AbortSignal.timeout(Math.min(input.wait_seconds * 1000 + 3000, 25_000));
    const signal = AbortSignal.any([cancellation, timeout]);
    try {
      for (let reads = 0; reads < 14; reads++) {
        signal.throwIfAborted();
        const { data, error } = await (session.client as RpcClient)
          .rpc("get_lifty_run_progress", { p_run_ref: input.run_ref }).abortSignal(signal);
        signal.throwIfAborted();
        if (error) throw failure(error);
        const parsed = RunProgressSnapshotSchema.safeParse(data);
        if (!parsed.success || parsed.data.run_ref !== input.run_ref) throw new PublicError({
          status: 502, code: "RUN_PROGRESS_INVALID", message: "Lifty received invalid research progress.",
          cause: parsed.success ? undefined : parsed.error,
        });
        const snapshot = parsed.data;
        const cursor = `rp1_${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
        const changed = cursor !== input.cursor;
        const terminal = snapshot.state === "succeeded" || snapshot.state === "failed";
        if (changed || terminal || Date.now() >= deadline || reads === 13) {
          return { ...snapshot, cursor, changed, terminal };
        }
        await pause(Math.min(2000, Math.max(0, deadline - Date.now())), signal);
      }
      throw new Error("unreachable progress bound");
    } catch (error) {
      if (cancellation.aborted) throw new PublicError({ status: 499, code: "REQUEST_CANCELLED",
        message: "Research progress request cancelled.", cause: error });
      if (timeout.aborted) throw new PublicError({ status: 504, code: "RUN_PROGRESS_TIMEOUT",
        message: "Research progress timed out. Retry the same run and cursor.", cause: error });
      throw error;
    } finally {
      activeUsers.delete(session.userId);
    }
  };
}
