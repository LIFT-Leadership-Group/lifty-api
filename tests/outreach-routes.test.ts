import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { executeOutreachOperation, outreachEntries } from "../src/outreach-operations.js";
import { memberReviewOperationDefinitions } from "../src/member-review-operations.js";
import { getStageMcpTools, callStageMcpTool } from "../src/mcp-stage-tools.js";

import { journeyRef, campaignRef, revisionRef, senderId, workspace, digest, policy, journeyPolicy, revision, executableVersion, journey, campaign, journeySummary, campaignSummary } from "./outreach-fixtures.js";
function harness(result: (name: string, args: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    try { return { data: result(name, args), error: null }; } catch (error) { return { data: null, error }; }
  });
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, request, rpc };
}

describe("canonical Outreach member transport", () => {
  it("routes every catalog operation to its exact RPC without a second workspace selector", async () => {
    const h = harness(name => name === "get_lifty_journeys" ? { workspace, journeys: [journeySummary], next_cursor: null }
      : name === "get_lifty_campaigns" ? { workspace, campaigns: [campaignSummary], next_cursor: null }
        : name === "activate_lifty_journey" ? { workspace, journey: { ...journey, active_revision: revision(journeyPolicy, true), executable_version: executableVersion } }
          : name.includes("journey") ? { workspace, journey: name === "publish_lifty_journey" ? { ...journey, draft_revision: revision(journeyPolicy, true), revisions: [revision(journeyPolicy, true)] } : journey }
            : name === "activate_lifty_campaign" ? { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: executableVersion } }
              : { workspace, campaign: name === "publish_lifty_campaign" ? { ...campaign, draft_revision: revision(policy, true), revisions: [revision(policy, true)] } : campaign });
    for (const { action, resource, definition } of outreachEntries().filter(entry => !(entry.action in memberReviewOperationDefinitions) && entry.action !== "runtime" && entry.action !== "reviews_get" && !entry.action.startsWith("tests_") && !entry.action.startsWith("message_") && entry.action !== "test_detail")) {
      const ref = resource === "journeys" ? journeyRef : campaignRef;
      const body = action === "post" ? resource === "journeys" ? { name: "Journey", policy: journeyPolicy } : { name: "LinkedIn", journey_ref: journeyRef, channel: "linkedin", policy }
        : action === "draft_patch" ? { expected_version: 1, revision_ref: revisionRef, changes: resource === "journeys" ? { audience: { kind: "qualified" } } : { instructions: "New instructions" } }
          : action === "pause" ? { expected_version: 1 }
            : action === "publish" || action === "activate" ? { expected_version: 1, revision_ref: revisionRef, digest } : undefined;
      const response = await h.request(definition.method, definition.route.replace(/\{[^}]+\}/g, ref), body);
      expect(response.status, `${resource}.${action}`).toBe(definition.success);
      expect(h.rpc).toHaveBeenLastCalledWith(definition.rpc, { p_workspace_id: null,
        ...definition.args({ path: action === "get" || action === "post" ? {} : { [`${resource === "journeys" ? "journey" : "campaign"}_ref`]: ref }, query: {}, body }) });
    }
  });
  it("rejects stale CAS through shared errors and never falls back after foreign selection", async () => {
    const h = harness(() => { throw { code: "PT409", message: "VERSION_CONFLICT", details: JSON.stringify({ current_version: 2 }) }; });
    const response = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest });
    expect(response.status).toBe(409); expect((await response.json()).error).toMatchObject({ code: "VERSION_CONFLICT", current_version: 2 });
    const foreign = harness(() => { throw { code: "PT403", message: "WORKSPACE_FORBIDDEN" }; });
    expect((await foreign.request("GET", "/v1/workspace/campaigns")).status).toBe(403);
    expect(foreign.rpc).toHaveBeenCalledOnce();
  });
  it.each([null, { workspace, campaigns: [], next_cursor: null, active: false }, { workspace, campaign: { ...campaign, campaign_ref: senderId } }])(
    "unverifiable reads stay unavailable instead of becoming empty/inactive", async value => {
      const h = harness(() => value);
      const response = await h.request("GET", `/v1/workspace/campaigns/${campaignRef}`);
      expect(response.status).toBe(502); expect((await response.json()).error.code).toBe("OUTREACH_UNAVAILABLE");
    });
  it("rejects provider fields, duplicate pins, noninteger CAS and unknown path before mutation", async () => {
    const h = harness(() => { throw new Error("must not call"); });
    for (const body of [{ expected_version: 0, revision_ref: revisionRef, digest }, { expected_version: 1.5, revision_ref: revisionRef, digest },
      { expected_version: 1, revision_ref: revisionRef, digest, provider: "vendor" }])
      expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, body)).status).toBe(422);
    // No customer-supplied binding: activation names only the exact revision.
    expect((await h.request("POST", `/v1/workspace/journeys/${journeyRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest,
      campaigns: [{ campaign_ref: campaignRef, revision_ref: revisionRef, digest }] })).status).toBe(422);
    expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, expected_journey_version: 1, revision_ref: revisionRef, digest })).status).toBe(422);
    expect((await h.request("GET", "/v1/workspace/campaigns/not-an-id")).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("publication and activation use different exact contracts; approval alone selects nothing and grants no intent", async () => {
    const published = { ...campaign, version: 2, draft_revision: revision(policy, true), revisions: [revision(policy, true)] };
    const h = harness(name => name === "publish_lifty_campaign" ? { workspace, campaign: published }
      : { workspace, campaign: { ...published, version: 3, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: executableVersion },
        customer_list: { state: "fresh", reason: null, checked_at: "2026-10-07T04:05:00.123+00:00" } });
    const pub = await (await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest })).json();
    expect(pub.campaign).toMatchObject({ state: "inactive", active_revision: null, draft_revision: { approval: { actor_ref: senderId } } });
    const activated = await (await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 2, revision_ref: revisionRef, digest })).json();
    expect(activated.journey.executable_version).toEqual(executableVersion); expect(activated.campaign.state).toBe("active");
    expect(activated.customer_list).toEqual({ state: "fresh", reason: null, checked_at: "2026-10-07T04:05:00.123+00:00" });
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(["publish_lifty_campaign", "activate_lifty_campaign"]);
  });
  it("LIF-1128: refuses activation while the CRM customer list is not current and says where to read why", async () => {
    const h = harness(() => { throw { code: "PT409", message: "OUTREACH_CUSTOMER_LIST_NOT_CURRENT" }; });
    const response = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 2, revision_ref: revisionRef, digest });
    const { error } = await response.json();
    expect([response.status, error.code]).toEqual([409, "OUTREACH_CUSTOMER_LIST_NOT_CURRENT"]);
    expect(error.message).toContain("crm_refresh");
  });
  it("never confirms a wrong approval digest, an unselected or paused activation, or a version pinning another revision", async () => {
    const other = { ...executableVersion, campaigns: [{ ...executableVersion.campaigns[0]!, revision: { revision_ref: senderId, digest } }] };
    for (const receipt of [
      { workspace, campaign },
      { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, false) }, journey },
      { workspace, campaign: { ...campaign, state: "paused", active_revision: revision(policy, true) }, journey },
      { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: other } },
    ]) {
      const h = harness(() => receipt);
      const result = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest });
      expect(result.status).toBe(502);
    }
    // A dependent Campaign may be selected while it waits outside the version.
    const waiting = harness(() => ({ workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey }));
    expect((await waiting.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(200);
    const h = harness(() => ({ workspace, campaign: { ...campaign, revisions: [{ ...revision(policy, true), digest: "b".repeat(64) }] } }));
    expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(502);
    const journeyActivation = harness(() => ({ workspace, journey: { ...journey, active_revision: revision(journeyPolicy, false) } }));
    expect((await journeyActivation.request("POST", `/v1/workspace/journeys/${journeyRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(502);
  });
  it("catalog and MCP expose implemented routes; old aliases and pending editor routes are unavailable", async () => {
    const tools = getStageMcpTools();
    for (const { key, resource, action, definition } of outreachEntries()) {
      const context = getAgentContext(resource);
      expect(context?.operations?.[action]?.route, key).toBe(definition.route);
      expect(tools.find(tool => tool.name === key.replaceAll(".", "_"))).toBeDefined();
    }
    for (const name of ["campaigns_post_read", "campaigns_post_write", "campaigns_client_email_write", "campaigns_resume", "campaigns_test", "campaigns_revise"]) {
      expect(tools.find(tool => tool.name === name)).toBeUndefined();
      const dispatch = vi.fn(); expect((await callStageMcpTool(name, {}, new Request("https://api.test"), dispatch)).isError).toBe(true); expect(dispatch).not.toHaveBeenCalled();
    }
    const h = harness(() => ({ workspace, campaigns: [], next_cursor: null }));
    expect((await h.request("PATCH", "/v1/workspace/campaigns", { scope: "workspace", request: {} })).status).toBe(404);
  });
});
