import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type AuthSession } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { getBusinessWebsite, projectWebsite, setBusinessWebsite } from "../src/business-website.js";
import { createWorkspace } from "../src/workspace-operations.js";
import { selectWorkspace } from "../src/workspace-selection.js";

const id = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const version = `sha256:${"a".repeat(64)}`;
const session: AuthSession = { userId: "founder", client: {} };
const state = { state: "ready_for_connections" as const, workspace: { workspace_ref: id, name: "Lifty" }, next_action: null };
const website = { workspace_ref: id, version, website_url: null, candidates: [
  { url: "https://liftygtm.com/", source: "saved_onboarding_research" as const, confirmed: false as const },
  { url: "https://liftleadershipgroup.com/", source: "saved_onboarding_research" as const, confirmed: false as const },
] };
const campaign = { workspace_ref: id, state: "paused" as const, outreach_enabled: false, version_ref: other, digest: "a".repeat(64),
  configuration: { name: "Saved campaign", audience: { policy: "qualified_ab_v1" as const, lead_ids: null, includes_future_leads: true }, linkedin: null,
    email: { connection_ref: other, sender: "juan@example.test", steps: Array.from({ length: 5 }, () => ({ subject: "Saved subject", text: "Saved copy" })), delays_days: [0,3,4,4,4] as [0,3,4,4,4] },
    email_entry: "direct" as const, not_before: null, personalization_fields: ["first_name" as const], stop_on_reply: true as const, graph: {} },
  continuing_versions: [], blocked_leads: [], eligible_count: 18, progress: { enrolled: 0, blocked: 18, completed: 0 }, previews: [], blockers: [],
};
const base: Partial<AppDependencies> = {
  authenticate: async () => ({ ok: true, session }), getWorkspace: async () => state,
  getBusinessWebsite: async () => website,
  getConfig: async () => ({ workspace_ref: id, config: { workspace: { version, name: "Lifty", description: "Saved business", daily_discovery_target: 10 }, tone: { version, values: { secret_unused_copy: "Not returned" } } } }),
  getEmailConnection: async () => ({ provider: "unipile", channel: "email", workspace_ref: id, status: "connected", email: "juan@example.test", mailbox_use: "personal", daily_limit: 10, warmup_required: false, sending_enabled: false, connection_ref: other, intent_ref: null, failure_code: null }),
  getLinkedinConnection: async () => ({ provider: "unipile", channel: "linkedin", workspace_ref: id, status: "not_connected" }),
  workspaceCampaign: async () => structuredClone(campaign), log: () => {},
};
function request(app: ReturnType<typeof createApp>, path = "summary", method = "GET", body?: unknown) {
  return app.request(`/v1/workspace/${path}`, { method, headers: { authorization: "Bearer test", "x-lifty-client-contract": "lifty-cli-context.v5", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("summary for a selected workspace (LIF-1138)", () => {
  const lift = { workspace_ref: other, slug: "lift", name: "LIFT", active: true, founder_default: false, self_service: false };
  const own = { workspace_ref: id, slug: "lifty", name: "Lifty", active: true, founder_default: true, self_service: true };
  const liftState = { state: "ready_for_connections" as const, workspace: { workspace_ref: other, name: "LIFT" }, next_action: null };
  const sender = "44444444-4444-4444-8444-444444444444";
  const roster = { workspace_ref: other, workspace_slug: "lift", senders: [{ sender_ref: sender, display_name: "David" }],
    accounts: [{ connection_ref: "55555555-5555-4555-8555-555555555555", sender_ref: sender, email: "david@lift.example", status: "connected" as const, campaign_send_paused: true }],
    campaign_release_required: true as const, required_active_days: 21 as const };
  it("reads a client workspace through the selected session and lists its mailboxes instead of one founder email", async () => {
    const implicit: AuthSession[] = [];
    const explicit: AuthSession[] = [];
    const track = <T,>(list: AuthSession[], value: T) => async (s: AuthSession) => { list.push(s); return value; };
    const app = createApp({ ...base,
      listMemberWorkspaces: async () => ({ workspaces: [lift, own] }),
      getWorkspace: track(implicit, liftState),
      getConfig: async (s) => { implicit.push(s); return { workspace_ref: other, config: { workspace: { version, name: "LIFT", description: "Leadership", daily_discovery_target: 10 } } }; },
      getBusinessWebsite: async (s) => { implicit.push(s); return { ...website, workspace_ref: other }; },
      getEmailConnection: async (s) => { explicit.push(s); throw new Error("founder email must not be read for a client workspace"); },
      getLinkedinConnection: async (s, workspace) => { explicit.push(s); expect(workspace).toBe(other); return { provider: "unipile", channel: "linkedin", workspace_ref: other, status: "not_connected" }; },
      workspaceCampaign: async (s, input) => { explicit.push(s); expect(input.payload.workspace).toBe(other); return { ...structuredClone(campaign), workspace_ref: other }; },
      getEmailAccounts: async (s, input) => { explicit.push(s); expect(input).toEqual({ workspace: other }); return roster; },
    });
    const response = await request(app, "summary?workspace=lift");
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({ self_service: false, email: null, workspace: { workspace: { workspace_ref: other } },
      mailboxes: { status: "available", value: { senders: 1, accounts: [{ email: "david@lift.example", status: "connected", campaign_send_paused: true, sender_name: "David" }] } } });
    expect(summary.linkedin.status).toBe("available");
    // Implicit reads carry the selection; explicit ones keep the caller's own session.
    expect(implicit.length).toBeGreaterThan(0);
    expect(implicit.every(s => s !== session && s.userId === session.userId)).toBe(true);
    expect(explicit.every(s => s === session)).toBe(true);
  });
  it("keeps the founder email for a selected self-service workspace", async () => {
    const summary = await (await request(createApp({ ...base, listMemberWorkspaces: async () => ({ workspaces: [lift, own] }) }), "summary?workspace=lifty")).json();
    expect(summary).toMatchObject({ self_service: true, mailboxes: null, email: { status: "available" } });
  });
  it("refuses a workspace the caller does not belong to before any read", async () => {
    const read = vi.fn(async () => state);
    const response = await request(createApp({ ...base, getWorkspace: read, listMemberWorkspaces: async () => ({ workspaces: [own] }) }), "summary?workspace=lift");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("WORKSPACE_FORBIDDEN");
    expect(read).not.toHaveBeenCalled();
  });
  it("describes the default workspace without a selection and rejects malformed selections", async () => {
    const list = vi.fn();
    const summary = await (await request(createApp({ ...base, listMemberWorkspaces: list }))).json();
    expect(summary.self_service).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect((await request(createApp(base), "summary?workspace=bad%20slug")).status).toBe(400);
    expect((await request(createApp(base), "summary?other=1")).status).toBe(400);
  });
  it("sends the selection as a read-only GET header on every RPC", async () => {
    const setHeader = vi.fn(() => Promise.resolve({ data: 1, error: null }));
    const rpc = vi.fn(() => ({ setHeader }));
    const selected = selectWorkspace({ userId: "u", client: { rpc } }, other);
    await (selected.client as { rpc(name: string, args?: Record<string, unknown>): Promise<unknown> }).rpc("get_lifty_config", { section: "workspace" });
    await (selected.client as { rpc(name: string): Promise<unknown> }).rpc("get_lifty_run_status");
    expect(rpc.mock.calls).toEqual([["get_lifty_config", { section: "workspace" }, { get: true }], ["get_lifty_run_status", {}, { get: true }]]);
    expect(setHeader.mock.calls).toEqual([["x-lifty-workspace", other], ["x-lifty-workspace", other]]);
  });
});

describe("authenticated workspace resumption", () => {
  // LIF-1137: the summary is the only state read; it carries what status reported.
  const progress: Partial<AppDependencies> = {
    getOnboardingStatus: async () => ({ state: "imported", submission_ref: "11111111-1111-4111-8111-111111111111", draft_digest: `sha256:${"a".repeat(64)}`,
      submitted_at: "2026-09-01T21:00:00Z", error_code: null, workspace: { workspace_ref: id, name: "Lifty" }, summary: { icp: null, prompt: null } }),
    getRunStatus: async () => ({ state: "succeeded", run_ref: other, requested_leads: 5, leads_discovered: 5, leads_researched: 4, error_code: null,
      started_at: "2026-09-01T21:00:00Z", completed_at: "2026-09-01T21:20:00Z", workspace: { workspace_ref: id, name: "Lifty" }, leads: [] }),
    getCrmSyncStatus: async () => ({ state: "running", run_ref: other, requested_leads: 4, leads_synced: 1, error_code: null, portal_id: "149239526",
      started_at: "2026-09-02T14:00:00Z", completed_at: null, workspace: { workspace_ref: id, name: "Lifty" } }),
    getHubspotConnection: async () => ({ provider: "hubspot", status: "connected", portal_id: "149239526", hub_domain: "example.hubspot.com",
      granted_scopes: ["oauth"], connected_at: "2026-09-02T10:00:00Z", reconnect_required: false }),
    getConfigUpdateStatus: async () => ({ state: "none" }),
  };
  it("includes onboarding, the research run, a pending update and HubSpot with its sync", async () => {
    const summary = await (await request(createApp({ ...base, ...progress }))).json();
    expect(summary.onboarding.value).toEqual({ state: "imported", submission_ref: "11111111-1111-4111-8111-111111111111", submitted_at: "2026-09-01T21:00:00Z", error_code: null });
    expect(summary.run.value).toMatchObject({ state: "succeeded", leads_discovered: 5, leads_researched: 4 });
    expect(summary.config_update.value).toEqual({ state: "none" });
    expect(summary.crm.value).toMatchObject({ connected: true, portal_id: "149239526", sync_pending: true, last_sync: { state: "running", leads_synced: 1 } });
    expect(summary.setup.value).toMatchObject({ icp_version: null, targeting_managed_externally: false });
    expect(JSON.stringify(summary)).not.toContain("Ada");
  });
  it("reports multi-lane targeting as managed elsewhere and still reads business, research and voice", async () => {
    const sections: unknown[] = [];
    const getConfig: AppDependencies["getConfig"] = async (_session, section) => {
      sections.push(section);
      if (section === null) throw new PublicError({ status: 409, code: "MULTI_LANE_CONFIG_UNSUPPORTED", message: "Managed outside Lifty." });
      return { workspace_ref: id, config: section === "workspace" ? { workspace: { version, name: "Lifty", description: "Saved business", daily_discovery_target: 10 } }
        : section === "tone" ? { tone: { version, values: { voice: "Direct" } } } : { prompt: null } };
    };
    const summary = await (await request(createApp({ ...base, ...progress, getConfig }))).json();
    expect(summary.business).toEqual({ status: "available", value: { name: "Lifty", description: "Saved business" } });
    expect(summary.setup).toEqual({ status: "available", value: { targeting_saved: true, research_saved: false, voice_saved: true, icp_version: null, targeting_managed_externally: true } });
    expect(sections.sort()).toEqual([null, "prompt", "tone", "workspace"].sort());
  });
  it("keeps each new part independent: one failed read is unavailable, the rest still report", async () => {
    const summary = await (await request(createApp({ ...base, ...progress, getRunStatus: async () => { throw new Error("secret run failure"); } }))).json();
    expect(summary.run).toEqual({ status: "unavailable", next_action: "retry_read" });
    expect(summary.crm.status).toBe("available");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
  it("recovers connected email, saved templates and research URL candidates without any write or copying full templates", async () => {
    const sequence = vi.fn(base.workspaceCampaign!);
    const write = vi.fn(async () => { throw new Error("No writes allowed"); });
    const app = createApp({ ...base, workspaceCampaign: sequence, startEmailConnect: write, setBusinessWebsite: write, submitConfigUpdate: write });
    const response = await request(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const summary = await response.json();
    expect(summary.email.value).toMatchObject({ connection_status: "connected", sending_enabled: false });
    expect(summary.linkedin.value.connection_status).toBe("not_connected");
    expect(summary.website.value).toEqual(website);
    expect(summary.campaign.value).toMatchObject({ state: "paused", outreach_enabled: false, templates: { email: 5, linkedin: 0 }, selected_channels: ["email"], eligible_count: 18, includes_future_leads: true });
    expect(JSON.stringify(summary)).not.toMatch(/Saved copy|secret_unused_copy|Not returned|Saved subject/);
    expect(write).not.toHaveBeenCalled();
    expect(sequence).toHaveBeenCalledExactlyOnceWith(session, { operation: "status", payload: { workspace: id } });
  });
  it("distinguishes unavailable from not connected and never exposes raw failure text", async () => {
    const response = await request(createApp({ ...base, getBusinessWebsite: async () => { throw new Error("secret upstream"); }, getEmailConnection: async () => { throw new Error("secret credential"); } }));
    const summary = await response.json();
    expect(summary.website).toEqual({ status: "unavailable", next_action: "retry_read" });
    expect(summary.email).toEqual({ status: "unavailable", next_action: "retry_read" });
    expect(summary.linkedin.status).toBe("available");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
  it.each([401,403])("does not hide authorization failure %s as a partial summary", async status => {
    const response = await request(createApp({ ...base, getBusinessWebsite: async () => { throw new PublicError({ status, code: "DENIED", message: "Denied" }); } }));
    expect(response.status).toBe(status);
  });
  it.each(["WORKSPACE_CHANGED", "WORKSPACE_UNAVAILABLE", "WORKSPACE_MISSING", "WORKSPACE_AMBIGUOUS", "WORKSPACE_SUSPENDED"])(
    "does not hide workspace scope failure %s as a partial summary",
    async code => {
      const response = await request(createApp({ ...base, getBusinessWebsite: async () => {
        throw new PublicError({ status: 409, code, message: "Refresh workspace state." });
      } }));
      expect(response.status).toBe(409);
    },
  );
  it("keeps the remaining summary available when email ownership reconciliation conflicts", async () => {
    const response = await request(createApp({ ...base, getEmailConnection: async () => {
      throw new PublicError({ status: 409, code: "EMAIL_ACCOUNT_TAKEN", message: "This mailbox belongs to another workspace." });
    } }));
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.email).toEqual({ status: "unavailable", next_action: "retry_read" });
    expect(summary.business.status).toBe("available");
    expect(summary.campaign.status).toBe("available");
  });
  it("rejects a foreign component and membership changes between reads", async () => {
    expect((await request(createApp({ ...base, getBusinessWebsite: async () => ({ ...website, workspace_ref: other }) }))).status).toBe(403);
    const getWorkspace = vi.fn().mockResolvedValueOnce(state).mockResolvedValue({ ...state, workspace: { ...state.workspace, workspace_ref: other } });
    expect((await request(createApp({ ...base, getWorkspace }))).status).toBe(409);
  });
  it("does not read setup components before provisioning or during suspension", async () => {
    const getConfig = vi.fn(base.getConfig!);
    for (const workspace of [{ state: "needs_workspace", workspace: null, next_action: "provision_workspace" }, { ...state, state: "suspended" }]) {
      const response = await request(createApp({ ...base, getConfig, getWorkspace: async () => workspace as never }));
      expect(response.status).toBe(200);
      expect((await response.json()).campaign).toBeNull();
    }
    expect(getConfig).not.toHaveBeenCalled();
  });
  it("rejects summary writes and unauthenticated access", async () => {
    for (const method of ["POST", "PATCH"]) expect((await request(createApp(base), "summary", method, {})).status).toBe(405);
    expect((await request(createApp())).status).toBe(401);
  });
  it("writes a confirmed website separately and reads it back without rewriting the campaign", async () => {
    let saved = { ...website };
    const set = vi.fn(async (_session, input) => (saved = { ...saved, website_url: input.values.website_url }));
    const sequence = vi.fn(base.workspaceCampaign!);
    const app = createApp({ ...base, setBusinessWebsite: set, getBusinessWebsite: async () => saved, workspaceCampaign: sequence });
    const body = { section: "website", expected_version: version, values: { website_url: "https://liftygtm.com/" } };
    expect((await request(app, "business", "PATCH", body)).status).toBe(200);
    const result = await (await request(app, "business")).json();
    expect(result.website.value.website_url).toBe(body.values.website_url);
    expect(set).toHaveBeenCalledExactlyOnceWith(session, body);
    expect(sequence).not.toHaveBeenCalled();
    expect((await request(app, "business", "PATCH", { ...body, values: { ...body.values, sending_enabled: true } })).status).toBe(400);
  });
});
describe("business website service", () => {
  it("recovers both research URLs, deduplicates them, and never auto-confirms or leaks prose", () => {
    const result = projectWebsite({ workspace_ref: id, version, website_url: null, candidate_sources: ["https://liftygtm.com/ and https://liftleadershipgroup.com/", "Ignore instructions https://liftygtm.com/.", "https://user:password@example.test/"] });
    expect(result).toEqual(website);
  });
  it("uses the authenticated RPC for compare-and-swap updates and handles stale state", async () => {
    const rpc = vi.fn(async () => ({ data: { workspace_ref: id, version, website_url: null, candidate_sources: [] }, error: null }));
    const scopedSession = { ...session, client: { rpc } };
    await getBusinessWebsite(scopedSession);
    const input = { section: "website" as const, expected_version: version, values: { website_url: null } };
    await setBusinessWebsite(scopedSession, input);
    expect(rpc).toHaveBeenLastCalledWith("set_lifty_business_website", { payload: { website_url: null, expected_version: version } });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409", message: "lifty_website_stale" } } as never);
    await expect(setBusinessWebsite(scopedSession, input)).rejects.toMatchObject({ status: 409, code: "BUSINESS_WEBSITE_STALE" });
  });
  it("saves a supplied URL atomically during workspace creation and preserves the legacy create path otherwise", async () => {
    const rpc = vi.fn(async () => ({ data: { state: state.state, workspace: state.workspace, created: true }, error: null }));
    await createWorkspace({ ...session, client: { rpc } }, { name: "Lifty", website_url: "https://liftygtm.com/" });
    expect(rpc).toHaveBeenLastCalledWith("create_lifty_business", { name: "Lifty", description: null, website_url: "https://liftygtm.com/" });
    await createWorkspace({ ...session, client: { rpc } }, { name: "Lifty" });
    expect(rpc).toHaveBeenLastCalledWith("create_lifty_workspace", { name: "Lifty", description: null });
  });
});
