import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { CampaignMessageResultSchema } from "../src/outreach-contracts.js";
import fixtures from "./outreach-message-sql-fixtures.json" with { type: "json" };
const source = fixtures.message_original.message;
const body = { request_ref: source.message_ref, source_digest: source.source_digest, expected_review_status: "pending",
  changes: { text: "Corrected saved draft" } };
function harness(receipt: unknown) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  return { rpc, request: (method: string, suffix = "", payload?: unknown) => app.request(`/v1/workspace/campaign-messages/${source.message_ref}${suffix}`, { method,
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}), }) };
}
describe("actual unapproved campaign message corrections", () => {
  it("routes exact saved source read and immutable pending replacement through shared RPC", async () => {
    const get = harness(fixtures.message_original);
    expect((await get.request("GET")).status).toBe(200);
    expect(get.rpc).toHaveBeenLastCalledWith("get_lifty_campaign_message", { p_workspace_id: null, p_message_id: source.message_ref });
    const post = harness(fixtures.message_revision);
    expect((await post.request("POST", "/revisions", body)).status).toBe(201);
    expect(post.rpc).toHaveBeenLastCalledWith("revise_lifty_campaign_message", { p_workspace_id: null, p_message_id: source.message_ref, p_payload: body });
  });
  it("cannot confirm unchanged source, foreign parent or missing exact person pin", async () => {
    for (const changes of [{ message_ref: source.message_ref }, { source_message_ref: null }, { sender_version: null }]) {
      const h = harness({ ...fixtures.message_revision, message: { ...fixtures.message_revision.message, ...changes } });
      expect((await h.request("POST", "/revisions", body)).status).toBe(502);
    }
  });
  it("accepts one atomic historical six-step email correction and rejects duplicate positions", async () => {
    const email = fixtures.email_original.message;
    const rpc = vi.fn(async () => ({ data: fixtures.email_revision, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const request = (changes: unknown) => app.request(`/v1/workspace/campaign-messages/${email.message_ref}/revisions`, {
      method: "POST", headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
      body: JSON.stringify({ request_ref: email.message_ref, source_digest: email.source_digest, expected_review_status: "pending", changes }),
    });
    expect((await request({ steps: [{ position: 1, text: "Corrected body" }, { position: 6, text: "Corrected final body" }] })).status).toBe(201);
    expect((await request({ steps: [{ position: 6, text: "A" }, { position: 6, text: "B" }] })).status).toBe(422);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("parses actual SQL LinkedIn and email source/replacement receipts", () => {
    for (const receipt of Object.values(fixtures)) expect(CampaignMessageResultSchema.safeParse(receipt)).toMatchObject({ success: true });
  });
});
