import { describe, it, expect, vi } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { listMemberWorkspaces } from "../src/member-workspaces.js";

const user = "11111111-1111-4111-8111-111111111111";
const path = "/v1/me/workspaces";
const lift = { workspace_ref: "22222222-2222-4222-8222-222222222222", slug: "lift", name: "LIFT", active: true };
const client = { workspace_ref: "33333333-3333-4333-8333-333333333333", slug: "acme", name: "Acme", active: false };
function harness(data: unknown = { workspaces: [client, lift] }, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: user, client: { rpc } } }), listMemberWorkspaces, log: () => {} });
  return { app, rpc };
}

describe("member workspace list", () => {
  it("requires a signed-in session before reading anything", async () => {
    const operation = vi.fn();
    expect((await createApp({ listMemberWorkspaces: operation }).request(path)).status).toBe(401);
    expect(operation).not.toHaveBeenCalled();
  });
  it("returns the caller-scoped database list without arguments", async () => {
    const h = harness();
    const response = await h.app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ workspaces: [client, lift] });
    expect(h.rpc).toHaveBeenCalledWith("lifty_member_workspaces");
  });
  it("maps a missing session to 401 without exposing database details", async () => {
    const response = await harness(null, { code: "PT401", message: "unauthenticated", details: "private-db-context" }).app.request(path);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private-db-context");
  });
  it("never reports a partial or malformed list", async () => {
    for (const [data, error] of [[null, { code: "42883", message: "function does not exist" }], [{ workspaces: [{ ...lift, owner: user }] }, null], [[lift], null]] as const) {
      const response = await harness(data, error).app.request(path);
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("WORKSPACES_UNAVAILABLE");
    }
  });
});
