import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { CampaignMessageResultSchema, CampaignReviewsSchema } from "../src/outreach-contracts.js";
import fixtures from "./outreach-message-sql-fixtures.json" with { type: "json" };
import reviewFixtures from "./campaign-review-sql-fixtures.json" with { type: "json" };
const source = fixtures.message_original.message;
const body = { request_ref: source.message_ref, source_digest: source.source_digest, expected_review_status: "pending",
  changes: { text: "Corrected saved draft" } };
function harness(receipt: unknown, messageRef = source.message_ref) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  return { rpc, request: (method: string, suffix = "", payload?: unknown) => app.request(`/v1/workspace/campaign-messages/${messageRef}${suffix}`, { method,
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
    expect(CampaignReviewsSchema.safeParse(reviewFixtures.queue)).toMatchObject({ success: true });
    for (const receipt of [reviewFixtures.approve, reviewFixtures.skip, reviewFixtures.retry])
      expect(CampaignMessageResultSchema.safeParse(receipt)).toMatchObject({ success: true });
  });
  it("lists saved reviews and records each exact CAS decision through the same Campaign owner", async () => {
    const rpc = vi.fn(async () => ({ data: reviewFixtures.queue, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const read = await app.request("/v1/workspace/campaign-reviews?channel=linkedin&limit=10", {
      headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenLastCalledWith("get_lifty_campaign_reviews", { p_workspace_id: null,
      p_query: { channel: "linkedin", limit: 10 } });
    for (const action of ["approve", "retry", "skip"] as const) {
      const receipt = reviewFixtures[action];
      const before = action === "skip" ? reviewFixtures.retry.message
        : reviewFixtures.queue.messages.find(message => message.message_ref === receipt.message.message_ref)!;
      const decision = { action, source_digest: before.source_digest, expected_review_status: before.review_status,
        ...(action === "skip" ? { reason: "Skip only this action." } : {}) };
      const h = harness(receipt, before.message_ref);
      expect((await h.request("POST", "/review", decision)).status).toBe(200);
      expect(h.rpc).toHaveBeenLastCalledWith("review_lifty_campaign_message", { p_workspace_id: null, p_message_id: before.message_ref, p_payload: decision });
    }
  });
  it("rejects unsafe retry, duplicate selectors and malformed decisions before any database mutation", async () => {
    const h = harness(fixtures.message_original);
    const decision = { action: "approve", source_digest: source.source_digest, expected_review_status: "pending" };
    for (const value of [ { ...decision, action: "retry" }, { ...decision, source_digest: "missing" },
      { ...decision, expected_review_status: "approved" }, { ...decision, action: "skip" }, { ...decision, send: true } ])
      expect((await h.request("POST", "/review", value)).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc: h.rpc } } }), log: () => {} });
    for (const query of ["channel=linkedin&channel=email", "limit=101", "after=not-an-id", "workspace=foreign"]) {
      const response = await app.request(`/v1/workspace/campaign-reviews?${query}`, {
        headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
      });
      expect(response.status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("does not confirm another message, an unrecorded decision or a conversation from another account", async () => {
    const approved = reviewFixtures.approve;
    const before = reviewFixtures.queue.messages.find(message => message.message_ref === approved.message.message_ref)!;
    const decision = { action: "approve", source_digest: before.source_digest, expected_review_status: "pending" };
    for (const changed of [{ message_ref: approved.message.lead_ref }, { review_status: "pending" },
      { account_id: null }, { sender_id: null }, { sender_name: null }, { channel: "email" }]) {
      const h = harness({ ...approved, message: { ...approved.message, ...changed } }, before.message_ref);
      expect((await h.request("POST", "/review", decision)).status).toBe(502);
    }
    const foreignHistory = { ...approved.message, account_id: approved.message.lead_ref };
    const h = harness({ ...approved, history: [foreignHistory] }, approved.message.message_ref);
    expect((await h.request("GET")).status).toBe(502);
    for (const code of ["OUTREACH_MESSAGE_MOVED", "OUTREACH_SEND_UNCONFIRMED", "OUTREACH_TARGET_STOPPED", "OUTREACH_APPROACH_UNAVAILABLE", "OUTREACH_SENDER_UNAVAILABLE", "OUTREACH_TEMPLATE_UNAVAILABLE"]) {
      const error = Object.assign(new Error(code), { code: "PT409" });
      const rpc = vi.fn(async () => ({ data: null, error }));
      const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
      const stale = await app.request(`/v1/workspace/campaign-messages/${before.message_ref}/review`, {
        method: "POST", headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" }, body: JSON.stringify(decision),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe(code);
      expect(rpc).toHaveBeenCalledOnce();
    }
  });
});
