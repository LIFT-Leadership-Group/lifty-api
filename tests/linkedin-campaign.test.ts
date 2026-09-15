import { describe, expect, it } from "vitest";
import { createLinkedinCampaignOperations } from "../src/linkedin-campaign.js";
import { LinkedinCampaignRequest, linkedinCampaignResultFor } from "../src/linkedin-campaign-contracts.js";
import { LINKEDIN_POLICY } from "../src/linkedin-contracts.js";

const workspace = "22222222-2222-4222-8222-222222222222", campaign = "33333333-3333-4333-8333-333333333333";
const connection = "44444444-4444-4444-8444-444444444444", lead = "55555555-5555-4555-8555-555555555555", version = "66666666-6666-4666-8666-666666666666";
const digest = "a".repeat(64), key = "linkedin-server-key-" + "x".repeat(32);
const prepare = { operation: "prepare" as const, payload: { workspace, lead_id: lead, connection_ref: connection, text: "Hello, after acceptance.\nExact text." } };
const preview = { workspace_ref: workspace, campaign_ref: campaign, connection_ref: connection, lead_id: lead, version_ref: version, digest, state: "draft", approved: false,
  content: { invitation: { note: null }, message: { text: prepare.payload.text }, target_identifier: "https://www.linkedin.com/in/recipient", timezone: "America/Argentina/Buenos_Aires", policy: LINKEDIN_POLICY }, actions: [], blockers: [] };

describe("LinkedIn campaigns", () => {
  it("uses only the authenticated caller RPC and dedicated capability; preserves exact content", async () => {
    const calls: unknown[] = [];
    const operations = createLinkedinCampaignOperations(key);
    const result = await operations({ userId: lead, client: { rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: preview, error: null }; } } }, prepare);
    expect(result).toEqual(preview);
    expect(calls).toEqual([{ name: "lifty_linkedin_campaign", args: { p_server_key: key, p_operation: "prepare", p_payload: prepare.payload } }]);
  });
  it.each([
    { ...prepare, payload: { ...prepare.payload, note: "optional note" } },
    { ...prepare, payload: { ...prepare.payload, text: " " } },
    { ...prepare, payload: { ...prepare.payload, text: "x".repeat(3001) } },
    { ...prepare, payload: { ...prepare.payload, steps: [] } },
    { operation: "activate", payload: { workspace, campaign_ref: campaign, digest } },
    { operation: "pause", payload: { workspace, campaign_ref: campaign, confirm: true } },
    { operation: "cancel", payload: { workspace, campaign_ref: campaign, digest, confirm: false } },
  ])("rejects unsupported actions or incomplete authorization before RPC: %j", input => {
    expect(LinkedinCampaignRequest.safeParse(input).success).toBe(false);
  });
  it.each(["approve", "activate", "pause", "cancel"] as const)("requires current digest and explicit %s", operation => {
    expect(LinkedinCampaignRequest.parse({ operation, payload: { workspace, campaign_ref: campaign, digest, confirm: true } })).toMatchObject({ operation });
  });
  it.each([
    { ...preview, workspace_ref: lead }, { ...preview, connection_ref: lead }, { ...preview, lead_id: connection },
    { ...preview, content: { ...preview.content, message: { text: "Changed" } } },
    { ...preview, content: { ...preview.content, invitation: { note: "Hidden note" } } },
    { ...preview, content: { ...preview.content, policy: { ...LINKEDIN_POLICY, invitations_per_day: 10 } } },
    { ...preview, provider_secret: "hidden" },
  ])("fails closed for mismatching result or policy: %j", data => {
    expect(() => linkedinCampaignResultFor(prepare, data)).toThrow();
  });
  it("can reapprove a paused campaign without changing it to active", () => {
    expect(linkedinCampaignResultFor({ operation: "approve", payload: { workspace, campaign_ref: campaign, digest, confirm: true } }, { ...preview, state: "paused", approved: true })).toMatchObject({ state: "paused", approved: true });
  });
  it("preserves a completed result when activation finds the one message already sent", () => {
    expect(linkedinCampaignResultFor({ operation: "activate", payload: { workspace, campaign_ref: campaign, digest, confirm: true } }, { ...preview, state: "completed", approved: true })).toMatchObject({ state: "completed" });
  });
  it("does not report cancellation when unsent actions remain eligible", () => {
    const data = { ...preview, state: "canceled", actions: [{ intent_ref: version, action_type: "message", status: "approved", provider_id: null, chat_id: null, acceptance_detected_at: null, error_code: null }] };
    expect(() => linkedinCampaignResultFor({ operation: "cancel", payload: { workspace, campaign_ref: campaign, digest, confirm: true } }, data)).toThrow();
  });
  it.each([["PT401", "linkedin_user_required", 401], ["PT403", "linkedin_workspace_forbidden", 403], ["PT409", "linkedin_approval_stale", 409]])("preserves safe auth and stale approval errors %s", async (code, message, status) => {
    const ops = createLinkedinCampaignOperations(key);
    await expect(ops({ userId: lead, client: { rpc: async () => ({ error: { code, message }, data: null }) } }, prepare)).rejects.toMatchObject({ code: message.toUpperCase(), status });
  });
  it("does not expose backend error details or provider payload", async () => {
    const ops = createLinkedinCampaignOperations(key);
    const error = await ops({ userId: lead, client: { rpc: async () => ({ error: { code: "PT409", message: "provider-token-SECRET" }, data: null }) } }, prepare).catch(error => error);
    expect(error).toMatchObject({ code: "LINKEDIN_CAMPAIGN_UNAVAILABLE", status: 502 });
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });
});
