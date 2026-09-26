import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createLinkedinConnectOperations } from "../src/linkedin-connect.js";
import { SenderChoice } from "../src/sender-choice.js";
import { LINKEDIN_POLICY } from "../src/linkedin-contracts.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const sender = "33333333-3333-4333-8333-333333333333";
const intent = "44444444-4444-4444-8444-444444444444";
const timezone = "America/Argentina/Buenos_Aires";
const settings = { dsn: "https://api1.unipile.com:13111", accessToken: "test-key", serverKey: "s".repeat(64),
  publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://project.supabase.co", publishableKey: "test-public" };
const getWorkspace = async () => ({ state: "ready_for_connections" as const,
  workspace: { workspace_ref: workspace, name: "Example" }, next_action: null });
const request = (app: ReturnType<typeof createApp>, path: string, body?: unknown) => app.request(`/v1/workspace/sending-accounts${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer test", "content-type": "application/json", "x-lifty-client-contract": "lifty-cli-context.v5" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("named sender setup", () => {
  it("reads only the authenticated current workspace's roster and rejects a foreign response", async () => {
    const roster = { workspace_ref: workspace, first_sender: { name: "Juan", is_current_user: true }, senders: [] };
    const rpc = vi.fn(async () => ({ data: roster, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "user", client: { rpc } } }), getWorkspace, log: () => {} });
    expect(await (await request(app, "/senders")).json()).toEqual(roster);
    expect(rpc).toHaveBeenCalledWith("lifty_sender_roster", { p_workspace: workspace });
    expect((await request(app, `/senders?workspace=${sender}`)).status).toBe(400);
    roster.workspace_ref = sender;
    expect((await request(app, "/senders")).status).toBe(503);
    expect((await createApp().request("/v1/workspace/sending-accounts/senders")).status).toBe(401);
  });

  it.each(["email", "linkedin"] as const)("retains an explicit %s sender through the authenticated RPC and rejects missing or mismatched confirmation", async channel => {
    const stored = { state: "pending", workspace_ref: workspace, intent_ref: intent, sender_ref: sender, sender_name: "Valen",
      email: null, mailbox_use: null, daily_limit: 10, timezone, expires_at: new Date(Date.now() + 600_000).toISOString() };
    const rpc = vi.fn(async () => ({ data: stored, error: null }));
    const session = { userId: "user", client: { rpc } };
    const choice = { kind: "existing" as const, sender_ref: sender };
    const start = () => channel === "email"
      ? createEmailConnectOperations(settings).start(session, { workspace, sender: choice })
      : createLinkedinConnectOperations(settings).start(session, { workspace, timezone, account_use: "personal", other_automation: false, sender: choice });
    expect(await start()).toMatchObject({ status: "pending", sending_enabled: false });
    expect(rpc.mock.calls[0]).toEqual([`lifty_${channel}_connection`, expect.objectContaining({ p_payload: expect.objectContaining({ sender: choice }) })]);
    stored.sender_ref = workspace;
    await expect(start()).rejects.toMatchObject({ code: "SENDER_SELECTION_UNAVAILABLE" });
    delete (stored as Partial<typeof stored>).sender_ref;
    await expect(start()).rejects.toMatchObject({ code: "SENDER_SELECTION_UNAVAILABLE" });
  });

  it.each(["email", "linkedin"] as const)("passes a named %s sender from the generic stage without changing authorization or activation", async channel => {
    const start = vi.fn(async (_session: unknown, _input: unknown) => ({ provider: "unipile" as const, channel, workspace_ref: workspace, status: "pending" as const,
      email: null, mailbox_use: null, daily_limit: 10, warmup_required: false, sending_enabled: false as const,
      profile_id: null, profile_url: null, display_name: null, timezone, account_use: "personal" as const, other_automation: false as const,
      policy: LINKEDIN_POLICY, health_status: "unknown" as const, connect_url: "https://api.lifty.test/connect",
      intent_ref: intent, expires_in_seconds: 600, expires_at: "2099-01-01T00:00:00Z" }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "user", client: {} } }), getWorkspace,
      startEmailConnect: async (...args) => ({ ...await start(...args), channel: "email" }),
      startLinkedinConnect: async (...args) => ({ ...await start(...args), channel: "linkedin" }), log: () => {} });
    const body = { channel, sender: { kind: "new", name: "Valen" }, ...(channel === "linkedin" ? { timezone, account_use: "personal", other_automation: false } : {}) };
    expect((await request(app, "", body)).status).toBe(200);
    expect(start.mock.calls[0]?.[1]).toMatchObject({ workspace, sender: body.sender, reconnect: true });
    expect((await request(app, "", { ...body, sender: { ...body.sender, workspace_ref: sender } })).status).toBe(400);
  });

  it("requires person names and accepts the automatic creator path without manufacturing a name", () => {
    expect(SenderChoice.parse({ kind: "self" })).toEqual({ kind: "self" });
    for (const name of ["LinkedIn", "Email", "", "juan@example.test", "Valen\nInjected"]) {
      expect(SenderChoice.safeParse({ kind: "new", name }).success).toBe(false);
    }
  });
});
