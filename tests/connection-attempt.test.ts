import { describe, expect, it, vi } from "vitest";
import { getConnectionAttempt } from "../src/connection-attempt.js";
const attempt = "11111111-1111-4111-8111-111111111111", workspace = "22222222-2222-4222-8222-222222222222";
describe("scoped authorization attempt read", () => {
  it.each(["hubspot", "slack", "email", "linkedin"] as const)("uses caller authentication and exact workspace/ref for %s", async provider => {
    const state = { status: "pending", attempt_ref: attempt, expires_at: "2099-09-16T20:00:00Z", retry_after_seconds: 3 };
    const rpc = vi.fn(async () => ({ data: state, error: null }));
    expect(await getConnectionAttempt({ userId: "founder", client: { rpc } }, provider, attempt, workspace)).toEqual(state);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_lifty_connection_attempt", { p_provider: provider, p_attempt_ref: attempt, p_workspace: workspace });
  });
  it.each([
    [{ data: null, error: { code: "PT404", message: "private database details" } }, 404],
    [{ data: null, error: { code: "PT503", message: "private database details" } }, 502],
    [{ data: { status: "connected", attempt_ref: workspace, verified: true }, error: null }, 502],
    [{ data: { status: "connected", attempt_ref: attempt, verified: false }, error: null }, 502],
    [{ data: { status: "unknown", attempt_ref: attempt }, error: null }, 502],
  ])("rejects inaccessible or unverified results without leaking internal errors", async (result, status) => {
    const rpc = vi.fn(async () => result);
    await expect(getConnectionAttempt({ userId: "founder", client: { rpc } }, "email", attempt, workspace)).rejects.toMatchObject({ status });
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("preserves read failure as unverified without any mutation or retry", async () => {
    const rpc = vi.fn(async () => { throw new Error("secret network details"); });
    await expect(getConnectionAttempt({ userId: "founder", client: { rpc } }, "slack", attempt, workspace)).rejects.toMatchObject({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE" });
    expect(rpc).toHaveBeenCalledOnce();
  });
});
