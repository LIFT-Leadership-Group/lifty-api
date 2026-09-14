import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { createSlackConnectOperations } from "../src/slack-connect.js";
import { openSlackConnectIntent } from "../src/slack-state.js";
const workspaceId = "63900000-0000-4000-a000-00000000000a";
const settings = { clientId: "client", clientSecret: "secret", publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://db.test", publishableKey: "test" };
const row = { intent_token: "a".repeat(64), workspace_id: workspaceId, workspace_name: "andSons", expires_in_seconds: 604800 };
const session = { userId: "member", client: {} };
const path = `/v1/workspaces/${workspaceId}/integrations/slack/connect-link`;
describe("workspace member Slack invitations", () => {
  it("uses the explicit workspace and seals the capability without exposing the session", async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const result = await createSlackConnectOperations(settings).createConnectLink({ ...session, client: { rpc } }, workspaceId);
    expect(rpc).toHaveBeenCalledWith("create_lifty_admin_slack_connect_intent", { p_workspace_id: workspaceId });
    expect(result).toMatchObject({ provider: "slack", workspace_id: workspaceId, workspace_name: "andSons", expires_in_seconds: 604800 });
    expect(openSlackConnectIntent(new URL(result.connect_url).searchParams.get("intent")!, settings.clientSecret)).toBe(row.intent_token);
    expect(JSON.stringify(result)).not.toContain(row.intent_token);
  });
  it.each([{ workspace_id: "63900000-0000-4000-a000-00000000000b" }, { expires_in_seconds: 600 }, { intent_token: "bad" }, { workspace_name: "" }])("rejects malformed or cross-tenant RPC output %j", async (override) => {
    const rpc = async () => ({ data: { ...row, ...override }, error: null });
    await expect(createSlackConnectOperations(settings).createConnectLink({ ...session, client: { rpc } }, workspaceId)).rejects.toMatchObject({ status: 502 });
  });
  it("maps database authorization denial to a safe forbidden response", async () => {
    const rpc = async () => ({ data: null, error: { code: "PT403", message: "private-marker" } });
    const error = await createSlackConnectOperations(settings).createConnectLink({ ...session, client: { rpc } }, workspaceId).catch(e => e);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(error.message).not.toContain("private-marker");
    expect(error.message).toBe("You must belong to this workspace to create a Slack invitation.");
  });
  it("requires authentication before minting a link", async () => {
    const mint = vi.fn();
    const response = await createApp({ createSlackConnectLink: mint }).request(path, { method: "POST" });
    expect(response.status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
  });
  it("returns an uncacheable link for the authenticated explicit workspace", async () => {
    const payload = { provider: "slack" as const, workspace_id: workspaceId, workspace_name: "andSons", expires_in_seconds: 604800, connect_url: "https://api.lifty.test/slack/start?intent=test" };
    const mint = vi.fn(async () => payload);
    const app = createApp({ authenticate: async () => ({ ok: true, session }), createSlackConnectLink: mint });
    const response = await app.request(path, { method: "POST", headers: { authorization: "Bearer test" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
    expect(mint).toHaveBeenCalledWith(session, workspaceId);
    const bad = await app.request(path.replace(workspaceId, "bad"), { method: "POST", headers: { authorization: "Bearer test" } });
    expect(bad.status).toBe(400);
    expect(mint).toHaveBeenCalledTimes(1);
  });
  it("preserves the backend membership denial", async () => {
    const app = createApp({ authenticate: async () => ({ ok: true, session }), createSlackConnectLink: async () => { throw new PublicError({status:403,code:"FORBIDDEN",message:"Workspace membership required"}); } });
    expect((await app.request(path, {method:"POST",headers:{authorization:"Bearer test"}})).status).toBe(403);
  });
});
