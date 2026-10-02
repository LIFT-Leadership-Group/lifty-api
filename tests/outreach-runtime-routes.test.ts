import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { CampaignRuntimeSchema } from "../src/outreach-contracts.js";
import fixture from "./outreach-runtime-sql-fixture.json" with { type: "json" };
it("reads started Journeys by retained executable version and recorded gates without claiming readiness from their absence", async () => {
  expect(CampaignRuntimeSchema.safeParse(fixture)).toMatchObject({ success: true });
  const rpc = vi.fn(async () => ({ data: fixture, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  const response = await app.request(`/v1/workspace/campaigns/${fixture.campaign_ref}/runtime`, {
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(fixture);
  expect(rpc).toHaveBeenCalledWith("get_lifty_campaign_runtime", { p_workspace_id: null, p_campaign_id: fixture.campaign_ref });
  expect(fixture.executable_versions.some(version => version.started_journeys > 0)).toBe(true);
  expect(fixture).not.toHaveProperty("ready");
});
