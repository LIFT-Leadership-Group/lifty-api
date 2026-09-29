import { describe, it, expect, vi } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { deleteOwnLogin } from "../src/login-deletion.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";

const user = "11111111-1111-4111-8111-111111111111", other = "33333333-3333-4333-8333-333333333333";
const path = "/v1/me/delete";
const post = (value: unknown = { confirm_email: "founder@example.test" }) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
function harness(data: unknown = { deleted: true, user_ref: user }, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: user, client: { rpc } } }), deleteOwnLogin, log: () => {} });
  return { app, rpc };
}

describe("self-service login deletion", () => {
  it("requires a signed-in session before deleting anything", async () => {
    const operation = vi.fn();
    expect((await createApp({ deleteOwnLogin: operation }).request(path, post())).status).toBe(401);
    expect(operation).not.toHaveBeenCalled();
  });
  it("passes only the typed confirmation to the caller-scoped database function", async () => {
    const h = harness();
    const response = await h.app.request(path, post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ deleted: true, user_ref: user });
    expect(h.rpc).toHaveBeenCalledWith("delete_lifty_own_login", { p_confirm_email: "founder@example.test" });
  });
  it("rejects missing confirmation and any attempt to name another user", async () => {
    const h = harness();
    for (const value of [{}, { confirm_email: "" }, { confirm_email: "founder@example.test", user_ref: other }, { confirm_email: "founder@example.test", user_id: other }])
      expect((await h.app.request(path, post(value))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["PT400", "login_delete_confirmation_mismatch", 400],
    ["PT409", "login_delete_workspace_membership", 409],
    ["PT409", "login_delete_history_retained", 409],
    ["PT404", "login_not_found", 404],
    ["PT401", "unauthenticated", 401],
  ])("maps %s %s without exposing database details", async (code, message, status) => {
    const h = harness(null, { code, message, details: "private-db-context" });
    const response = await h.app.request(path, post());
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).toContain(message.toUpperCase());
    expect(text).not.toContain("private-db-context");
  });
  it("never reports success for a receipt about another user or an unknown database error", async () => {
    for (const [data, error] of [[{ deleted: true, user_ref: other }, null], [null, { code: "23503", message: "fk violation" }], [{ deleted: false }, null]] as const) {
      const response = await harness(data, error).app.request(path, post());
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("LOGIN_DELETION_UNAVAILABLE");
    }
  });
  it("is a destructive connector tool on the same route", () => {
    const tool = getStageMcpTools().find(entry => entry.name === "business_delete_login");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(JSON.stringify(tool?.inputSchema)).toContain("confirm_email");
  });
});
