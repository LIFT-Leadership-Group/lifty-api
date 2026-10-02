import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { CampaignTestResultSchema, CampaignTestsSchema } from "../src/outreach-contracts.js";
import fixtures from "./outreach-test-sql-fixtures.json" with { type: "json" };
const test = fixtures.test_pending.test;
const body = { request_ref: test.request_ref, expected_version: 1, revision_ref: test.revision_ref, digest: test.digest,
  sample: { lead_refs: [test.samples[0]!.lead_ref] } };
function harness(result: unknown) {
  const rpc = vi.fn(async () => ({ data: result, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  return { rpc, request: (method: string, path: string, payload?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}), }) };
}
describe("isolated saved campaign tests", () => {
  it("accepts durable queued work and exposes saved list/detail through exact RPCs", async () => {
    const prefix = `/v1/workspace/campaigns/${test.campaign_ref}/tests`;
    const h = harness(fixtures.test_pending);
    expect((await h.request("POST", prefix, body)).status).toBe(202);
    expect(h.rpc).toHaveBeenLastCalledWith("create_lifty_campaign_test", { p_workspace_id: null, p_campaign_id: test.campaign_ref, p_payload: body });
    const list = harness(fixtures.tests_list);
    expect((await list.request("GET", prefix)).status).toBe(200);
    expect(list.rpc).toHaveBeenLastCalledWith("get_lifty_campaign_tests", { p_workspace_id: null, p_campaign_id: test.campaign_ref, p_query: {} });
    const detail = harness(fixtures.test_completed);
    expect((await detail.request("GET", `${prefix}/${test.test_ref}`)).status).toBe(200);
    expect(detail.rpc).toHaveBeenLastCalledWith("get_lifty_campaign_test", { p_workspace_id: null, p_campaign_id: test.campaign_ref, p_test_id: test.test_ref });
  });
  it("rejects ambiguous or unbounded samples before queue mutation", async () => {
    const h = harness(fixtures.test_pending);
    for (const sample of [{ lead_refs: [], baseline_test_ref: test.test_ref }, { lead_refs: [] },
      { lead_refs: Array(21).fill(test.samples[0]!.lead_ref) }, { lead_refs: [test.samples[0]!.lead_ref], country: "US" }])
      expect((await h.request("POST", `/v1/workspace/campaigns/${test.campaign_ref}/tests`, { ...body, sample })).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("does not confirm another campaign, candidate, request or sample receipt", async () => {
    for (const changed of [{ campaign_ref: test.test_ref }, { request_ref: test.test_ref }, { digest: "b".repeat(64) },
      { samples: [{ ...test.samples[0], lead_ref: test.test_ref }] }]) {
      const h = harness({ ...fixtures.test_pending, test: { ...test, ...changed } });
      expect((await h.request("POST", `/v1/workspace/campaigns/${test.campaign_ref}/tests`, body)).status).toBe(502);
    }
  });
  it("parses actual SQL queued/completed/baseline receipts and bounded discovery", () => {
    for (const value of [fixtures.test_pending, fixtures.test_completed, fixtures.baseline_candidate])
      expect(CampaignTestResultSchema.safeParse(value)).toMatchObject({ success: true });
    expect(CampaignTestsSchema.safeParse(fixtures.tests_list)).toMatchObject({ success: true });
  });
});
