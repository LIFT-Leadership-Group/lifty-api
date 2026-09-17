import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type AuthSession } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { getBusinessWebsite, projectWebsite, setBusinessWebsite } from "../src/business-website.js";
import { createWorkspace } from "../src/workspace-operations.js";

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
describe("authenticated workspace resumption", () => {
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
  it.each([401,403,409])("does not hide authorization/state failure %s as a partial summary", async status => {
    const response = await request(createApp({ ...base, getBusinessWebsite: async () => { throw new PublicError({ status, code: "DENIED", message: "Denied" }); } }));
    expect(response.status).toBe(status);
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
