import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunProgressReader, RunProgressQuerySchema, RunProgressSchema } from "../src/run-progress.js";
import { createApp } from "../src/app.js";
import { stageOperations } from "../src/stage-contracts.js";
import { getAgentContext } from "../src/agent-context.js";

const run = "912d0000-0000-4000-a000-000000000001";
const workspace = "912b0000-0000-4000-a000-000000000001";
const initial = {
  run_ref: run, workspace_ref: workspace, attempt: 0, state: "running" as const,
  requested_leads: 5, leads_discovered: 5, leads_researched: 0, error_code: null,
  leads: [{ lead_ref: "912c0000-0000-4000-a000-000000000001", name: "Ada", company: "Example",
    research_available: false, tier: null, fit_rationale: null, linkedin_url: null }],
};
const controller = () => new AbortController();
function fixture() {
  const read = vi.fn().mockResolvedValue({ data: initial, error: null });
  const rpc = vi.fn(() => ({ abortSignal: read }));
  const session = { userId: "founder", client: { rpc } };
  return { read, rpc, session, progress: createRunProgressReader() };
}
const query = (extra = {}) => ({ run_ref: run, wait_seconds: 25, ...extra });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("resumable research observations", () => {
  it("returns the full initial cohort immediately, then waits for a new completion", async () => {
    vi.useFakeTimers();
    const f = fixture(); const signal = controller().signal;
    const first = await f.progress(f.session, query(), signal);
    expect(first).toMatchObject({ changed: true, terminal: false, leads_researched: 0, leads: initial.leads });
    expect(f.rpc).toHaveBeenCalledWith("get_lifty_run_progress", { p_run_ref: run });
    const completed = { ...initial, leads_researched: 1, leads: [{ ...initial.leads[0], research_available: true, tier: "C", fit_rationale: "Confirmed mismatch" }] };
    f.read.mockResolvedValueOnce({ data: initial, error: null }).mockResolvedValueOnce({ data: completed, error: null });
    const next = f.progress(f.session, query({ cursor: first.cursor }), signal);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await next).toMatchObject({ changed: true, leads_researched: 1, leads: completed.leads });
    expect((await next).cursor).not.toBe(first.cursor);
  });

  it("returns unchanged snapshot after the bounded wait without duplicate completion", async () => {
    vi.useFakeTimers(); const f = fixture(); const signal = controller().signal;
    const first = await f.progress(f.session, query(), signal);
    const waiting = f.progress(f.session, query({ cursor: first.cursor }), signal);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toEqual({ ...first, changed: false });
    expect(f.rpc).toHaveBeenCalledTimes(13); // initial + 12 reads inside the 22s wait budget
  });

  it("resumes across reader instances and changes cursor when the attempt changes", async () => {
    const f = fixture(); const signal = controller().signal;
    const first = await f.progress(f.session, query(), signal);
    const resumed = await createRunProgressReader()(f.session, query({ cursor: first.cursor, wait_seconds: 0 }), signal);
    expect(resumed.changed).toBe(false);
    f.read.mockResolvedValue({ data: { ...initial, attempt: 1 }, error: null });
    const retry = await f.progress(f.session, query({ cursor: first.cursor }), signal);
    expect(retry.changed).toBe(true); expect(retry.cursor).not.toBe(first.cursor);
  });

  it.each(["succeeded", "failed"])("returns terminal %s immediately even with an unchanged cursor", async state => {
    const f = fixture(); const signal = controller().signal;
    f.read.mockResolvedValue({ data: { ...initial, state, error_code: state === "failed" ? "research_failed" : null }, error: null });
    const first = await f.progress(f.session, query(), signal);
    expect(await f.progress(f.session, query({ cursor: first.cursor }), signal)).toMatchObject({ changed: false, terminal: true, state });
  });

  it("reanalyzes authorization on every read and stops immediately after membership revocation", async () => {
    vi.useFakeTimers(); const f = fixture(); const signal = controller().signal;
    const first = await f.progress(f.session, query(), signal);
    f.read.mockResolvedValueOnce({ data: initial, error: null }).mockResolvedValueOnce({ data: null, error: { code: "PT404", message: "secret" } });
    const waiting = f.progress(f.session, query({ cursor: first.cursor }), signal);
    const rejected = expect(waiting).rejects.toMatchObject({ status: 404, code: "RUN_NOT_FOUND" });
    await vi.advanceTimersByTimeAsync(2000); await rejected;
    expect(f.rpc).toHaveBeenCalledTimes(3);
  });

  it("forwards cancellation to the read and releases the per-user slot", async () => {
    const f = fixture(); const abort = controller();
    f.read.mockImplementationOnce(async signal => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = f.progress(f.session, query(), abort.signal);
    await expect(f.progress(f.session, query(), controller().signal)).rejects.toMatchObject({ status: 429 });
    abort.abort(); await expect(pending).rejects.toMatchObject({ status: 499 });
    await expect(f.progress(f.session, query(), controller().signal)).resolves.toMatchObject({ changed: true });
  });

  it("aborts a stalled database read within the hard 25-second deadline", async () => {
    const timeout = controller();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const f = fixture();
    f.read.mockImplementationOnce(async signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const waiting = f.progress(f.session, query(), controller().signal);
    expect(timeoutSignal).toHaveBeenCalledWith(25_000);
    timeout.abort();
    await expect(waiting).rejects.toMatchObject({ status: 504, code: "RUN_PROGRESS_TIMEOUT" });
    expect(f.rpc).toHaveBeenCalledOnce();
  });

  it("cancels the inter-read wait without starting another RPC", async () => {
    vi.useFakeTimers(); const f = fixture(); const abort = controller();
    const first = await f.progress(f.session, query(), abort.signal);
    const waiting = f.progress(f.session, query({ cursor: first.cursor }), abort.signal);
    await vi.advanceTimersByTimeAsync(10); abort.abort();
    await expect(waiting).rejects.toMatchObject({ status: 499 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it("caps simultaneous readers across users", async () => {
    const f = fixture(); const abort = controller();
    f.read.mockImplementation(async signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const pending = Array.from({ length: 64 }, (_, i) => f.progress({ ...f.session, userId: `user-${i}` }, query(), abort.signal).catch(e => e));
    await expect(f.progress(f.session, query(), abort.signal)).rejects.toMatchObject({ status: 429 });
    abort.abort(); await Promise.all(pending);
  });

  it("rejects mismatched runs, oversized snapshots and uncurated internal fields", async () => {
    const f = fixture(); const signal = controller().signal;
    for (const data of [{ ...initial, run_ref: workspace }, { ...initial, provider_trace: "private" }, { ...initial, leads: Array(26).fill(initial.leads[0]) }]) {
      f.read.mockResolvedValue({ data, error: null });
      await expect(f.progress(f.session, query(), signal)).rejects.toMatchObject({ status: 502, code: "RUN_PROGRESS_INVALID" });
    }
  });
});

describe("progress route and published operation", () => {
  const headers = { "x-lifty-client-contract": "lifty-cli-context.v5" };
  it("requires current authentication before reading progress", async () => {
    const getRunProgress = vi.fn();
    const response = await createApp({ getRunProgress }).request(`/v1/workspace/runs/progress?run_ref=${run}`, { headers });
    expect(response.status).toBe(401); expect(getRunProgress).not.toHaveBeenCalled();
  });
  it("publishes the generic GET operation and returns no-store curated output", async () => {
    const f = fixture(); const app = createApp({ authenticate: async () => ({ ok: true, session: f.session }), getRunProgress: f.progress });
    const response = await app.request(`/v1/workspace/runs/progress?run_ref=${run}&wait_seconds=0`, { headers });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(RunProgressSchema.safeParse(await response.json()).success).toBe(true);
    expect(stageOperations["sample-review"]?.progress).toMatchObject({ method: "GET", route: "/v1/workspace/runs/progress" });
    expect(getAgentContext("sample-review")?.instructions).toContain("not\na persisted event history");
  });
  it.each(["", `run_ref=${run}&wait_seconds=26`, `run_ref=${run}&cursor=bad`, `run_ref=${run}&workspace=${workspace}`])("rejects unbounded or unscoped input %s", async qs => {
    const getRunProgress = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }), getRunProgress });
    const response = await app.request(`/v1/workspace/runs/progress?${qs}`, { headers });
    expect(response.status).toBe(400); expect(getRunProgress).not.toHaveBeenCalled();
  });
  it("defines numeric query bounds for generic CLI validation", () => {
    expect(RunProgressQuerySchema.parse({ run_ref: run, wait_seconds: "25" }).wait_seconds).toBe(25);
  });
});
