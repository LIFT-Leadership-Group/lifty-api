import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createWorkspaceCampaignOperations } from "../src/workspace-campaign.js";
import { WorkspaceCampaignRequest, workspaceCampaignResultFor, type WorkspaceCampaignOutput } from "../src/workspace-campaign-contracts.js";
const workspace = "22222222-2222-4222-8222-222222222222";
const sender = "33333333-3333-4333-8333-333333333333";
const version = "44444444-4444-4444-8444-444444444444";
const digest = "a".repeat(64);
const configuration = { name: "Workspace outreach", email: { connection_ref: sender, steps: Array.from({ length: 5 }, (_, index) => ({ subject: "Hello", text: `Email ${index + 1} for {{first_name}}` })) } };
const prepare = { operation: "prepare" as const, payload: { workspace, configuration } };
const preview: WorkspaceCampaignOutput = { workspace_ref: workspace, version_ref: version, digest, state: "draft", outreach_enabled: false, eligible_count: 5, continuing_versions: [], blocked_leads: [], progress: { enrolled: 0, blocked: 0, completed: 0 }, previews: [], blockers: [],
  configuration: { name: configuration.name, audience: { policy: "qualified_ab_v1", lead_ids: null, includes_future_leads: true }, linkedin: null,
    email: { ...configuration.email, sender: "founder@example.test", delays_days: [0, 3, 4, 4, 4] }, email_entry: "direct", not_before: null,
    personalization_fields: ["first_name", "last_name", "company_name"], stop_on_reply: true, graph: { schema_version: "journey_graph.v1.1" } } };
const control = { workspace, version_ref: version, digest, confirm: true as const };
const headers = { authorization: "Bearer scoped", "content-type": "application/json", "x-lifty-client-contract": "lifty-cli-context.v5" };

describe("workspace campaign setup", () => {
  it("requires the full five-email preparation without lead selection or a date/time", () => {
    expect(WorkspaceCampaignRequest.parse(prepare)).toEqual(prepare);
    expect(WorkspaceCampaignRequest.safeParse({ ...prepare, payload: { workspace, configuration: { ...configuration, email: { ...configuration.email, steps: configuration.email.steps.slice(0, 1) } } } }).success).toBe(false);
    expect(WorkspaceCampaignRequest.safeParse({ operation: "activate", payload: { workspace, version_ref: version, digest } }).success).toBe(false);
  });
  it("pins workspace, sender, full templates and audience in preparation readback", () => {
    expect(workspaceCampaignResultFor(prepare, preview)).toEqual(preview);
    expect(() => workspaceCampaignResultFor(prepare, { ...preview, workspace_ref: sender })).toThrow();
    expect(() => workspaceCampaignResultFor(prepare, { ...preview, configuration: { ...preview.configuration, audience: { policy: "qualified_ab_v1", lead_ids: [sender], includes_future_leads: false } } })).toThrow();
    expect(() => workspaceCampaignResultFor(prepare, { ...preview, configuration: { ...preview.configuration, email: { ...preview.configuration!.email, steps: configuration.email.steps.map(s => ({ ...s, text: "Changed" })) } } })).toThrow();
  });
  it("uses the caller JWT and capability for the complete workspace operation", async () => {
    const rpc = vi.fn(async () => ({ data: preview, error: null }));
    const operate = createWorkspaceCampaignOperations("x".repeat(32));
    expect(await operate({ userId: "founder", client: { rpc } }, prepare)).toEqual(preview);
    expect(rpc).toHaveBeenCalledWith("lifty_workspace_outreach", { p_server_key: "x".repeat(32), p_operation: "prepare", p_payload: prepare.payload });
  });
  it("default stage read, full preparation and one activation confirmation use the workspace handler", async () => {
    let saved = structuredClone(preview);
    const workspaceCampaign = vi.fn(async (_session, input) => {
      if (input.operation === "activate") saved = { ...saved, state: "active", outreach_enabled: true };
      return saved;
    });
    const individual = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: workspace, name: "Example" }, next_action: null }),
      workspaceCampaign, emailCampaign: individual, log: () => {} });
    expect((await app.request("/v1/workspace/campaigns", { headers })).status).toBe(200);
    expect(workspaceCampaign).toHaveBeenLastCalledWith(expect.anything(), { operation: "status", payload: { workspace } });
    expect((await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify({ scope: "workspace", request: prepare }) })).status).toBe(200);
    expect(saved.outreach_enabled).toBe(false);
    const activation = await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify({ scope: "workspace", request: { operation: "activate", payload: control } }) });
    expect(activation.status).toBe(200);
    expect(await activation.json()).toMatchObject({ state: "active", outreach_enabled: true });
    expect(individual).not.toHaveBeenCalled();
    expect((await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify({ scope: "workspace", request: { ...prepare, payload: { ...prepare.payload, workspace: sender } } }) })).status).toBe(403);
  });
  it("never confirms activation for a stale version, paused result or unresolved blockers", () => {
    const input = WorkspaceCampaignRequest.parse({ operation: "activate", payload: control });
    for (const result of [preview, { ...preview, state: "active", outreach_enabled: true, version_ref: sender }, { ...preview, state: "active", outreach_enabled: true, blockers: ["sender_unhealthy"] }]) expect(() => workspaceCampaignResultFor(input, result)).toThrow();
  });
});
