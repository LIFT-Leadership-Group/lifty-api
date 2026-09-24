import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import { getAgentContext } from "../src/agent-context.js";
import { CampaignStagePatchSchema, CampaignStageRequestSchema } from "../src/stage-contracts.js";
import { SharedCampaignConfigurationInput } from "../src/shared-campaign-contracts.js";
import { WorkspaceCampaignRequest, workspaceCampaignResultFor, type WorkspaceCampaignOutput } from "../src/workspace-campaign-contracts.js";
import { createWorkspaceCampaignOperations } from "../src/workspace-campaign.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333";
const version = "44444444-4444-4444-8444-444444444444";
const nextVersion = "55555555-5555-4555-8555-555555555555";
const digest = "a".repeat(64);
const nextDigest = "b".repeat(64);
const examples = [...readFileSync(new URL("../src/agent-context/campaign.md", import.meta.url), "utf8").matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
const configure = WorkspaceCampaignRequest.parse(examples[0].request);
if (configure.operation !== "configure") throw new Error("Expected runnable configure example");
const configuration = configure.payload.configuration;
const shared = {
  ...configuration,
  audience: { policy: "qualified_ab_v1" as const, lead_ids: null, includes_future_leads: true },
  linkedin: { ...configuration.linkedin!, sender: "https://www.linkedin.com/in/founder", timezone: "America/Argentina/Buenos_Aires", invitation_note: null },
  email: null, not_before: null, stop_on_reply: true as const,
};
const saved: WorkspaceCampaignOutput = {
  workspace_ref: workspace, state: "draft", outreach_enabled: false,
  version_ref: version, digest, configuration: shared,
  preparation: { state: "pending", errors: [] }, continuing_versions: [], blocked_leads: [], eligible_count: 3,
  progress: { enrolled: 0, blocked: 0, completed: 0 }, previews: [], blockers: [],
};
const modify = WorkspaceCampaignRequest.parse({ operation: "modify", payload: {
  workspace, version_ref: version, digest, changes: { linkedin: { overlay: "Only a short greeting." } },
} });
const changed = { ...saved, version_ref: nextVersion, digest: nextDigest,
  configuration: { ...shared, linkedin: { ...shared.linkedin, overlay: "Only a short greeting." } } };
const headers = { authorization: "Bearer scoped", "content-type": "application/json", "x-lifty-client-contract": "lifty-cli-context.v5" };
const base: Partial<AppDependencies> = {
  authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
  getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: workspace, name: "Example" }, next_action: null }), log: () => {},
};

describe("shared campaign contracts and saved policy", () => {
  it("runs the published one-greeting example with no copy array, fixed language field or sample audience", () => {
    expect(CampaignStageRequestSchema.parse(examples[0])).toEqual(examples[0]);
    expect(CampaignStagePatchSchema.parse(examples[1])).toEqual(examples[1]);
    expect(configuration.linkedin!.compose_mode).toBe("generate");
    expect(configuration.graph.blocks.filter(b => b.action === "linkedin_message")).toHaveLength(1);
    expect(configuration.lead_ids).toBeUndefined();
    expect(workspaceCampaignResultFor(configure, saved)).toEqual(saved);
    for (const extra of [{ person_country: "BR" }, { language: "auto" }, { messages: [{ text: "Hello" }] }]) {
      expect(SharedCampaignConfigurationInput.safeParse({ ...configuration, linkedin: { ...configuration.linkedin, ...extra } }).success).toBe(false);
    }
  });

  it("requires paired CAS for replacement and a nonempty patch, allowing explicit clears", () => {
    for (const refs of [{ version_ref: version }, { digest }, { version_ref: version, digest: "wrong" }]) {
      expect(WorkspaceCampaignRequest.safeParse({ ...configure, payload: { ...configure.payload, ...refs } }).success).toBe(false);
    }
    expect(WorkspaceCampaignRequest.safeParse({ ...configure, payload: { ...configure.payload, version_ref: version, digest } }).success).toBe(true);
    for (const changes of [{}, { linkedin: {} }, { linkedin: { template_bank: " " } },
      { linkedin: { compose_mode: "generate", template_bank: "Bank" } }, { engine: "fixed_v1" }, { unknown: true }]) {
      expect(WorkspaceCampaignRequest.safeParse({ operation: "modify", payload: { workspace, version_ref: version, digest, changes } }).success).toBe(false);
    }
    const clears = { linkedin: { compose_mode: "generate", template_bank: null }, email: null, lead_ids: null, not_before: null };
    expect(WorkspaceCampaignRequest.safeParse({ operation: "modify", payload: { workspace, version_ref: version, digest, changes: clears } }).success).toBe(true);
    expect(SharedCampaignConfigurationInput.safeParse({ ...configuration, linkedin: { ...configuration.linkedin, template_bank: "Unwanted bank" } }).success).toBe(false);
    expect(SharedCampaignConfigurationInput.safeParse({ ...configuration, linkedin: { ...configuration.linkedin, compose_mode: "templates", template_bank: "Saved bank" } }).success).toBe(true);
  });

  it("executes the documented timing edit against a saved graph without adding a follow-up", () => {
    const guide = getAgentContext("campaign")!.instructions;
    const script = /```javascript\n([\s\S]*?)\n```/.exec(guide)![1]!;
    const directory = mkdtempSync(join(tmpdir(), "lifty-campaign-guide-"));
    const file = join(directory, "saved.json");
    try {
      writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      const missing = spawnSync(process.execPath, ["--input-type=module", "-", file], { input: script, encoding: "utf8" });
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toBe("");
      const graph = structuredClone(configuration.graph);
      graph.blocks.splice(3, 0, { key: "send_second_linkedin_message", kind: "provider_action", channel: "linkedin", provider: "unipile", action: "linkedin_message" });
      graph.transitions[2]!.from = "send_second_linkedin_message";
      graph.transitions.splice(2, 0, { key: "followup", branch_key: "outreach", from: "send_first_linkedin_message", to: "send_second_linkedin_message",
        trigger: { type: "time", after: { business_days: 4 }, anchor: "action_completed" } });
      writeFileSync(file, JSON.stringify({ ...saved, configuration: { ...shared, graph } }));
      const edited = spawnSync(process.execPath, ["--input-type=module", "-", file], { input: script, encoding: "utf8" });
      expect(edited.status).toBe(0);
      const request = CampaignStagePatchSchema.parse(JSON.parse(edited.stdout));
      expect(request).toMatchObject({ scope: "workspace", request: { operation: "modify", payload: { workspace, version_ref: version, digest } } });
      const expected = structuredClone(graph);
      expected.transitions[2]!.trigger = { type: "time", after: { business_days: 2 }, anchor: "action_completed" };
      expect(JSON.parse(edited.stdout).request.payload.changes).toEqual({ graph: expected });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("publishes real graph fields and rejects dangling references, duplicate keys and unsupported transport fields", () => {
    for (const graph of [
      { ...configuration.graph, anything: true },
      { ...configuration.graph, blocks: [configuration.graph.blocks[0], configuration.graph.blocks[0]] },
      { ...configuration.graph, transitions: configuration.graph.transitions.map((t, i) => i ? t : { ...t, to: "missing" }) },
      { ...configuration.graph, transitions: configuration.graph.transitions.map((t, i) => i ? t : { ...t, trigger: { type: "time", after: { days: -1 } } }) },
    ]) expect(SharedCampaignConfigurationInput.safeParse({ ...configuration, graph }).success).toBe(false);
    const graph = structuredClone(configuration.graph);
    graph.transitions.reverse();
    expect(() => workspaceCampaignResultFor(configure, { ...saved, configuration: { ...shared, graph } })).toThrow(/content mismatch/);
  });

  it("preserves declared email delivery specs and bounds the existing executor's cadence", () => {
    const spec = { email: { steps: Array.from({ length: 4 }, (_, i) => ({ seq_number: i + 1, delay_in_days: i ? 2 : 0 })) } };
    const input = { ...configuration, delivery_specs: spec };
    expect(SharedCampaignConfigurationInput.safeParse(input).success).toBe(true);
    for (const steps of [spec.email.steps.slice(0, 3), spec.email.steps.map(s => ({ ...s, delay_in_days: 31 })), spec.email.steps.map(s => ({ ...s, seq_number: 1 }))]) {
      expect(SharedCampaignConfigurationInput.safeParse({ ...input, delivery_specs: { email: { steps } } }).success).toBe(false);
    }
    const request = WorkspaceCampaignRequest.parse({ ...configure, payload: { workspace, configuration: input } });
    expect(() => workspaceCampaignResultFor(request, saved)).toThrow(/content mismatch/);
    expect(workspaceCampaignResultFor(request, { ...saved, configuration: { ...shared, delivery_specs: spec } }).configuration).toMatchObject({ delivery_specs: spec });
  });

  it("rejects altered scope, graph, mode, overlay, audience and missing preparation receipts", () => {
    for (const configuration of [
      { ...shared, name: "Other" },
      { ...shared, linkedin: { ...shared.linkedin, connection_ref: version } },
      { ...shared, linkedin: { ...shared.linkedin, overlay: "Other" } },
      { ...shared, linkedin: { ...shared.linkedin, compose_mode: "templates" } },
      { ...shared, audience: { ...shared.audience, lead_ids: [connection], includes_future_leads: false } },
      { ...shared, email: { connection_ref: connection, sender: "sender@example.test", compose_mode: "generate", overlay: "Other" } },
    ]) expect(() => workspaceCampaignResultFor(configure, { ...saved, configuration })).toThrow();
    expect(() => workspaceCampaignResultFor(configure, { ...saved, workspace_ref: connection })).toThrow();
    const { preparation: _, ...noPreparation } = saved;
    expect(() => workspaceCampaignResultFor(configure, noPreparation)).toThrow();
    // jsonb key ordering does not create a false mismatch.
    const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
    expect(workspaceCampaignResultFor(configure, reverseKeys(saved))).toEqual(saved);
  });

  it("validates changed fields and preserved fields against the pre-edit receipt", () => {
    expect(workspaceCampaignResultFor(modify, changed, saved)).toEqual(changed);
    for (const wrong of [
      { ...changed, configuration: { ...changed.configuration, name: "Unrelated changed name" } },
      { ...changed, configuration: { ...changed.configuration, linkedin: { ...changed.configuration.linkedin, compose_mode: "templates" } } },
      { ...changed, version_ref: version },
      { ...changed, version_ref: version, digest },
      { ...changed, outreach_enabled: true, state: "active" },
    ]) expect(() => workspaceCampaignResultFor(modify, wrong, saved)).toThrow();
    const noOp = WorkspaceCampaignRequest.parse({ operation: "modify", payload: { workspace, version_ref: version, digest, changes: { name: shared.name } } });
    expect(workspaceCampaignResultFor(noOp, saved, saved)).toEqual(saved);
  });

  it("removes a template bank and clears explicit audiences without overwriting channels", () => {
    const before = { ...saved, configuration: { ...shared, audience: { ...shared.audience, lead_ids: [connection], includes_future_leads: false },
      linkedin: { ...shared.linkedin, compose_mode: "templates" as const, template_bank: "Old bank" } } };
    const patch = WorkspaceCampaignRequest.parse({ operation: "modify", payload: { workspace, version_ref: version, digest,
      changes: { lead_ids: null, linkedin: { compose_mode: "generate", template_bank: null } } } });
    expect(workspaceCampaignResultFor(patch, { ...saved, version_ref: nextVersion, digest: nextDigest }, before)).toMatchObject({
      configuration: { audience: { lead_ids: null, includes_future_leads: true }, linkedin: { compose_mode: "generate" } },
    });
  });

  it("refreshes sender metadata for an explicitly replaced connection while preserving its writing policy", () => {
    const patch = WorkspaceCampaignRequest.parse({ operation: "modify", payload: { workspace, version_ref: version, digest,
      changes: { linkedin: { connection_ref: nextVersion } } } });
    const replacement = { ...saved, version_ref: nextVersion, digest: nextDigest, configuration: { ...shared,
      linkedin: { ...shared.linkedin, connection_ref: nextVersion, sender: "https://www.linkedin.com/in/new-sender", timezone: "UTC" } } };
    expect(workspaceCampaignResultFor(patch, replacement, saved)).toEqual(replacement);
    expect(() => workspaceCampaignResultFor(patch, { ...replacement, configuration: { ...replacement.configuration,
      linkedin: { ...replacement.configuration.linkedin, overlay: "Unexpected new policy" } } }, saved)).toThrow(/unrelated field/);
  });

  it("requires ready preparation for activation of the exact approved policy", () => {
    const activate = WorkspaceCampaignRequest.parse({ operation: "activate", payload: { workspace, version_ref: version, digest, confirm: true } });
    for (const state of ["pending", "failed"]) expect(() => workspaceCampaignResultFor(activate,
      { ...saved, state: "active", outreach_enabled: true, preparation: { state, errors: [] } })).toThrow();
    expect(() => workspaceCampaignResultFor(activate, { ...saved, state: "active", outreach_enabled: true,
      preparation: { state: "ready", errors: ["unresolved"] } })).toThrow();
    expect(workspaceCampaignResultFor(activate, { ...saved, state: "active", outreach_enabled: true, preparation: { state: "ready", errors: [] } })).toMatchObject({ state: "active" });
  });
});

describe("shared campaign operations", () => {
  it("forwards configure to the same authenticated workspace RPC", async () => {
    const rpc = vi.fn(async () => ({ data: saved, error: null }));
    expect(await createWorkspaceCampaignOperations("x".repeat(32))({ userId: "founder", client: { rpc } }, configure)).toEqual(saved);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("lifty_workspace_outreach", { p_server_key: "x".repeat(32), p_operation: "configure", p_payload: configure.payload });
  });

  it("pre-reads a modification and verifies the nested merge without exposing a mismatched receipt", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: saved, error: null }).mockResolvedValueOnce({ data: changed, error: null });
    const operate = createWorkspaceCampaignOperations("x".repeat(32));
    expect(await operate({ userId: "founder", client: { rpc } }, modify)).toEqual(changed);
    expect(rpc.mock.calls.map(call => call[1].p_operation)).toEqual(["status", "modify"]);
    rpc.mockReset().mockResolvedValueOnce({ data: saved, error: null }).mockResolvedValueOnce({ data: { ...changed, configuration: { ...changed.configuration, name: "Secret other tenant" } }, error: null });
    await expect(operate({ userId: "founder", client: { rpc } }, modify)).rejects.toMatchObject({ code: "WORKSPACE_CAMPAIGN_UNAVAILABLE" });
  });

  it("does not mutate on stale references or cross-workspace pre-read", async () => {
    const operate = createWorkspaceCampaignOperations("x".repeat(32));
    const rpc = vi.fn(async (): Promise<{ data: WorkspaceCampaignOutput; error: null }> => ({ data: { ...saved, digest: nextDigest }, error: null }));
    await expect(operate({ userId: "founder", client: { rpc } }, modify)).rejects.toMatchObject({ code: "OUTREACH_APPROVAL_STALE" });
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockReset().mockResolvedValue({ data: { ...saved, workspace_ref: connection }, error: null });
    await expect(operate({ userId: "founder", client: { rpc } }, modify)).rejects.toMatchObject({ code: "WORKSPACE_CAMPAIGN_UNAVAILABLE" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("maps public preparation and stale errors, hiding unrecognized provider details", async () => {
    const rpc = vi.fn();
    const operate = createWorkspaceCampaignOperations("x".repeat(32));
    for (const [message, code] of [["outreach_preparation_pending", "OUTREACH_PREPARATION_PENDING"], ["outreach_approval_stale", "OUTREACH_APPROVAL_STALE"], ["private upstream secret", "WORKSPACE_CAMPAIGN_UNAVAILABLE"]]) {
      rpc.mockResolvedValue({ data: null, error: { code: "PT409", message } });
      await expect(operate({ userId: "founder", client: { rpc } }, configure)).rejects.toMatchObject({ code });
    }
  });

  it("serves configure, ready readback, partial PATCH and activation separately through authenticated stages", async () => {
    let current: WorkspaceCampaignOutput = saved;
    const workspaceCampaign = vi.fn(async (_session, input) => {
      if (input.operation === "modify") current = changed;
      if (input.operation === "activate") current = { ...current, state: "active", outreach_enabled: true };
      return current;
    });
    const individual = vi.fn();
    const app = createApp({ ...base, workspaceCampaign, linkedinCampaign: individual });
    const response = await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify(examples[0]) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preparation: { state: "pending" }, outreach_enabled: false });
    expect((await app.request("/v1/workspace/campaigns", { method: "PATCH", headers, body: JSON.stringify({ scope: "workspace", request: modify }) })).status).toBe(200);
    expect(workspaceCampaign).toHaveBeenLastCalledWith(expect.anything(), modify);
    current = { ...changed, preparation: { state: "ready", errors: [] } };
    const read = await app.request("/v1/workspace/campaigns", { headers });
    expect(await read.json()).toMatchObject({ configuration: { linkedin: { overlay: "Only a short greeting." }, audience: { includes_future_leads: true } }, preparation: { state: "ready" } });
    const activation = { scope: "workspace", request: { operation: "activate", payload: { workspace, version_ref: nextVersion, digest: nextDigest, confirm: true } } };
    expect((await app.request("/v1/workspace/campaigns", { method: "PATCH", headers, body: JSON.stringify(activation) })).status).toBe(400);
    expect((await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify(activation) })).status).toBe(200);
    expect(individual).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant stage reads/writes and malformed requests before dispatch", async () => {
    const workspaceCampaign = vi.fn(async () => saved);
    const app = createApp({ ...base, workspaceCampaign });
    for (const request of [configure, modify]) {
      expect((await app.request("/v1/workspace/campaigns", { method: "POST", headers,
        body: JSON.stringify({ scope: "workspace", request: { ...request, payload: { ...request.payload, workspace: connection } } }) })).status).toBe(403);
    }
    expect(workspaceCampaign).not.toHaveBeenCalled();
    expect((await app.request("/v1/workspace/campaigns", { method: "POST", headers, body: JSON.stringify({ scope: "workspace", request: { ...configure, payload: { ...configure.payload, digest } } }) })).status).toBe(400);
    expect(workspaceCampaign).not.toHaveBeenCalled();
    const wrong = createApp({ ...base, workspaceCampaign: async () => ({ ...saved, workspace_ref: connection }) });
    const read = await wrong.request("/v1/workspace/campaigns", { headers });
    expect(read.status).toBe(500);
    expect(await read.text()).not.toContain(shared.linkedin.sender);
  });

  it("resumes a generated campaign without mistaking zero fixed templates for unconfigured outreach", async () => {
    const response = await createApp({ ...base, workspaceCampaign: async () => saved }).request("/v1/workspace/summary", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ campaign: { status: "available", value: { engine: "shared_v1", compose_modes: { linkedin: "generate", email: null }, templates: { linkedin: 0, email: 0 }, preparation: { state: "pending" }, includes_future_leads: true } } });
  });

  it("serves the shared capabilities in both task and stage context without private reads", async () => {
    const never = async () => { throw new Error("No tenant reads from public context"); };
    const app = createApp({ authenticate: never, getWorkspace: never, workspaceCampaign: never });
    const task = await (await app.request("/v1/context/campaign")).json();
    const stage = await (await app.request("/v1/context/campaigns")).json();
    expect(task.schemas.workspace_campaign).toBeDefined();
    for (const guide of [task.instructions, stage.instructions, stage.references.campaign]) {
      expect(guide).toContain("shared_v1");
      expect(guide).toContain("future eligible");
      expect(guide).toContain("modify");
    }
    expect(task.instructions).toContain("linkedin_connection_request_accepted");
    expect(task.instructions).toContain("action_completed");
    expect(task.instructions).toContain("one, two or three");
    expect(stage.references.writing).toContain("single greeting stays a single greeting");
    expect(stage.references.writing).not.toContain("Do not add research placeholders or promise new AI-written");
    expect(getAgentContext("summary")!.instructions).toContain("Zero legacy templates is normal");
  });
});
