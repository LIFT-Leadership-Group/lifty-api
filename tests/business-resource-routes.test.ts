import { describe, it, expect, vi } from "vitest";
import { PublicError } from "../src/errors.js";
import { createApp, type AppDependencies } from "../src/app.js";
import {
  getAgentContext,
  STAGE_CLIENT_CONTRACT,
} from "../src/agent-context.js";
import { getStageMcpTools, callStageMcpTool } from "../src/mcp-stage-tools.js";
import {
  profileFixture,
  membershipFixture,
  workspaceRef,
  laneFixture,
  criteriaFixture,
  draftGetFixture,
  draftFixture,
} from "./business-fixtures.js";
const headers = {
  authorization: "Bearer founder",
  "x-lifty-client-contract": STAGE_CLIENT_CONTRACT,
  "content-type": "application/json",
};
const identity = {
  workspace_ref: workspaceRef,
  name: "Example",
  state: "ready_for_connections",
};
const get = { workspace: identity, profile: profileFixture };
const rpcNames: Record<string, unknown> = {
  get_lifty_business_profile: get,
  get_lifty_targeting: {
    workspace_ref: workspaceRef,
    targeting: {
      version: 1,
      updated_at: profileFixture.updated_at,
      lanes: [laneFixture],
    },
  },
  get_lifty_research_criteria: {
    workspace_ref: workspaceRef,
    criteria: criteriaFixture,
  },
  get_lifty_setup_status: { workspace_ref: workspaceRef, state: "none" },
  get_lifty_setup_draft: draftGetFixture,
  get_lifty_commercial_voice: {
    workspace_ref: workspaceRef,
    voice: {
      version: 0,
      updated_at: profileFixture.updated_at,
      tone: null,
      rules: [],
    },
  },
};
function harness(
  reply?: unknown,
  error: unknown = null,
  options: Partial<AppDependencies> = {},
) {
  const rpc = vi.fn(async (name: string, _args?: unknown) => ({
    data: reply ?? rpcNames[name],
    error,
  }));
  const authenticate = vi.fn(async () => ({
    ok: true as const,
    session: { userId: "founder", client: { rpc } },
  }));
  const app = createApp({
    authenticate,
    listMemberWorkspaces: async () => ({ workspaces: [membershipFixture] }),
    log: () => {},
    ...options,
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, rpc, authenticate, request };
}
describe("typed Business direct HTTP boundary", () => {
  it("creates explicitly with one authenticated RPC and reports a replay without a second resource", async () => {
    const created = { ...get, created: true, voice: { version: 0 } };
    const h = harness(created);
    expect(
      (
        await h.request("/v1/workspace/business", "POST", {
          name: " Example ",
          website_url: null,
        })
      ).status,
    ).toBe(201);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "create_lifty_business_profile",
      { p_payload: { name: "Example", website_url: null } },
    );
    expect(h.authenticate).toHaveBeenCalledOnce();
    const replay = await harness({ ...created, created: false }).request(
      "/v1/workspace/business",
      "POST",
      { name: "Example", website_url: null },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).created).toBe(false);
  });
  it.each([
    { expected_version: 1, name: null },
    { expected_version: 1 },
    {
      expected_version: 1,
      offerings: [{ text: " ", provenance: "confirmed" }],
    },
    { expected_version: 1, offerings: [{ text: "X", provenance: "inferred" }] },
    {
      expected_version: 1,
      offerings: [
        { text: "x", provenance: "confirmed" },
        { text: " X ", provenance: "confirmed" },
      ],
    },
    {
      expected_version: 1,
      offerings: Array.from({ length: 11 }, (_, i) => ({
        text: `${i}`,
        provenance: "confirmed",
      })),
    },
    {
      expected_version: 1,
      value_proposition: { text: "x".repeat(501), provenance: "confirmed" },
    },
    {
      expected_version: 1,
      website_url: {
        text: "https://user:secret@example.com",
        provenance: "confirmed",
      },
    },
    {
      expected_version: 1,
      one_liner: { text: "Good", provenance: "confirmed", source: "website" },
    },
    { expected_version: 1, section: "workspace", values: { name: "bad" } },
  ])(
    "returns bounded repair issues and makes no RPC for invalid profile %#",
    async (body) => {
      const h = harness();
      const response = await h.request("/v1/workspace/business", "PATCH", body);
      expect(response.status).toBe(422);
      const output = await response.json();
      expect(output.error).toMatchObject({
        code: "PROFILE_INVALID",
        issues: expect.arrayContaining([
          {
            code: expect.any(String),
            path: expect.any(String),
            message: expect.any(String),
            suggestion: expect.any(String),
          },
        ]),
      });
      expect(JSON.stringify(output)).not.toContain("user:secret");
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["CRITERIA_REGENERATION_REQUIRED", "PT409", 409],
    ["PROFILE_CONFIRMATION_REQUIRED", "PT409", 409],
    ["SETUP_REQUIRED", "PT409", 409],
    ["TARGETING_LANE_UNKNOWN", "PT422", 422],
    ["VERSION_REQUIRED", "PT422", 422],
  ])(
    "preserves the expected SQL repair state %s",
    async (message, code, status) => {
      const h = harness(null, {
        code,
        message,
        details: JSON.stringify({
          stale_sources: ["profile", "base"],
          private: "Secret upstream detail",
        }),
      });
      const response = await h.request(
        "/v1/workspace/research-criteria",
        "PATCH",
        { expected_version: 1, research_fields: [] },
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error.code).toBe(message);
      expect(body.error.message).not.toContain("could not be verified");
      expect(body.error.stale_sources).toEqual(["profile", "base"]);
      expect(JSON.stringify(body)).not.toContain("Secret");
    },
  );
  it("patches profile values directly without regeneration or receipt transport", async () => {
    const h = harness({ ...get, profile: { ...profileFixture, version: 2 } });
    const body = {
      expected_version: 1,
      one_liner: { text: "Less manual work", provenance: "confirmed" },
      description: null,
    };
    const result = await h.request("/v1/workspace/business", "PATCH", body);
    expect(result.status).toBe(200);
    expect((await result.json()).profile.version).toBe(2);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "patch_lifty_business_profile",
      { p_workspace_id: null, p_payload: body },
    );
    expect(h.authenticate).toHaveBeenCalledOnce();
  });
  it("preserves CAS and suspension errors without leaking database detail", async () => {
    const h = harness(null, {
      code: "PT409",
      message: "VERSION_CONFLICT",
      details: JSON.stringify({ current_version: 3, secret: "private" }),
    });
    const response = await h.request("/v1/workspace/business", "PATCH", {
      expected_version: 1,
      name: "Changed",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "VERSION_CONFLICT",
      current_version: 3,
    });
    const suspended = harness(null, {
      code: "PT409",
      message: "WORKSPACE_SUSPENDED",
      details: "secret database context",
    });
    const blocked = await suspended.request(
      "/v1/workspace/commercial-voice",
      "PATCH",
      { expected_version: 0, tone: "Warm" },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).not.toContain("secret database");
  });
  it("returns the database selection rule as public codes with the caller's workspaces", async () => {
    const workspaces = [
      { workspace_ref: workspaceRef, name: "Example", slug: "example" },
      { workspace_ref: "11111111-1111-4111-8111-111111111111", name: "Other", slug: "other" },
    ];
    const ambiguous = await harness(null, {
      code: "PT409",
      message: "lifty_workspace_ambiguous",
      details: JSON.stringify({ workspaces }),
    }).request("/v1/workspace/business");
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).error).toEqual({
      code: "WORKSPACE_SELECTION_REQUIRED",
      message: expect.any(String),
      workspaces,
    });
    const foreign = await harness(null, { code: "PT403", message: "lifty_workspace_forbidden" }).request(
      "/v1/workspace/business",
      "PATCH",
      { expected_version: 1, name: "Changed" },
      { "x-lifty-workspace": "foreign" },
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("WORKSPACE_FORBIDDEN");
  });
  it("allows a missing workspace read and refuses storing a setup draft before creation", async () => {
    const h = harness({ workspace: null, profile: null });
    expect(await (await h.request("/v1/workspace/business")).json()).toEqual({
      workspace: null,
      profile: null,
    });
    const draft = await harness(null, { code: "PT409", message: "WORKSPACE_NOT_READY" }).request(
      "/v1/workspace/setup/draft",
      "PATCH",
      { expected_version: 0, draft: draftFixture, generated_criteria: null },
    );
    expect(draft.status).toBe(409);
    expect((await draft.json()).error.code).toBe("WORKSPACE_NOT_READY");
  });
  it("preserves partial lanes and independently required criteria input without provider fields", async () => {
    const h = harness(rpcNames.get_lifty_targeting);
    const body = {
      expected_version: 1,
      lanes: [
        { id: laneFixture.id, company: { excluded_industry_codes: ["5241"] } },
      ],
    };
    expect(
      (await h.request("/v1/workspace/targeting", "PATCH", body)).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("patch_lifty_targeting", {
      p_workspace_id: null,
      p_payload: body,
    });
    for (const invalid of [
      { ...body, lanes: [{ id: laneFixture.id, allocation_weight: 10 }] },
      {
        ...body,
        lanes: [
          {
            id: laneFixture.id,
            company: {
              employees: [
                { min: 100, max: 200 },
                { min: 10, max: 20 },
              ],
            },
          },
        ],
      },
    ])
      expect(
        (await h.request("/v1/workspace/targeting", "PATCH", invalid)).status,
      ).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("saves voice version0 directly and rejects unrelated business facts", async () => {
    const h = harness({
      workspace_ref: workspaceRef,
      voice: {
        version: 1,
        updated_at: profileFixture.updated_at,
        tone: "Warm",
        rules: [{ kind: "avoid", text: "Emojis", source: "founder_feedback" }],
      },
    });
    const body = {
      expected_version: 0,
      tone: "Warm",
      rules: [{ kind: "avoid", text: "Emojis", source: "founder_feedback" }],
    };
    expect(
      (await h.request("/v1/workspace/commercial-voice", "PATCH", body)).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "patch_lifty_commercial_voice",
      { p_workspace_id: null, p_payload: body },
    );
    expect(
      (
        await h.request("/v1/workspace/commercial-voice", "PATCH", {
          ...body,
          value_prop: "Wrong owner",
        })
      ).status,
    ).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("stores a server draft and refuses client-bound draft versions in generated criteria", async () => {
    const h = harness({ ...draftGetFixture, version: 2 });
    expect(
      (
        await h.request("/v1/workspace/setup/draft", "PATCH", {
          expected_version: 1,
          draft: draftFixture,
          generated_criteria: null,
        })
      ).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("save_lifty_setup_draft", {
      p_workspace_id: null,
      p_payload: {
        expected_version: 1,
        draft: draftFixture,
        generated_criteria: null,
      },
    });
    // The server binds generated criteria to the draft version it saves;
    // clients send only the profile and base versions they generated from.
    const { version: _, updated_at: __, ...generated } = criteriaFixture;
    const response = await h.request("/v1/workspace/setup/draft", "PATCH", {
      expected_version: 1,
      draft: draftFixture,
      generated_criteria: {
        ...generated,
        source_versions: { profile_version: 1, base_version: "base-v1", draft_version: 2 },
      },
    });
    expect(response.status).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("publishes real current base plus API guidance only to an authenticated selected member", async () => {
    const h = harness({
      workspace_ref: workspaceRef,
      profile: profileFixture,
      draft: draftGetFixture,
      base: { version: "base-v1", text: "Mandatory Scout base" },
    });
    const response = await h.request("/v1/workspace/setup/context");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      base: { version: "base-v1", text: "Mandatory Scout base" },
      generation_rules: expect.any(Array),
      criteria_schema: { type: "object" },
      draft_schema: { type: "object" },
    });
    expect(JSON.stringify(data.generation_rules)).not.toMatch(
      /Apollo|Unipile|HeyReach|Smartlead|Mailivery/i,
    );
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("get_lifty_setup_context", {
      p_workspace_id: null,
    });
  });
  it("submits the exact saved draft version and replays its receipt; discard after submission stays forbidden", async () => {
    const receipt = {
      workspace_ref: workspaceRef,
      state: "imported",
      setup_ref: "55555555-5555-4555-8555-555555555555",
      draft_version: 2,
      profile_version: 1,
      targeting_version: 1,
      criteria_version: 1,
      submitted_at: profileFixture.updated_at,
    };
    const h = harness(receipt);
    for (let i = 0; i < 2; i++)
      expect(
        await (
          await h.request("/v1/workspace/setup", "POST", {
            expected_draft_version: 2,
          })
        ).json(),
      ).toEqual(receipt);
    expect(h.rpc.mock.calls[0]).toEqual([
      "submit_lifty_setup",
      { p_workspace_id: null, p_expected_draft_version: 2 },
    ]);
    expect(h.rpc.mock.calls[1]).toEqual(h.rpc.mock.calls[0]);
    const forbidden = harness(null, {
      code: "PT409",
      message: "SETUP_ALREADY_SUBMITTED",
    });
    expect(
      (await forbidden.request("/v1/workspace/setup/draft", "DELETE")).status,
    ).toBe(409);
    expect(forbidden.rpc).toHaveBeenCalledExactlyOnceWith(
      "discard_lifty_setup_draft",
      { p_workspace_id: null },
    );
  });
  it("rejects hostile output instead of serializing it and retains stale source conflicts", async () => {
    const h = harness({ ...get, private_token: "secret" });
    const response = await h.request("/v1/workspace/business");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private_token");
    const stale = harness(null, {
      code: "PT409",
      message: "SETUP_STALE",
      details: JSON.stringify({ stale_sources: ["profile", "base"] }),
    });
    const rejected = await stale.request("/v1/workspace/setup", "POST", {
      expected_draft_version: 1,
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.stale_sources).toEqual([
      "profile",
      "base",
    ]);
  });
  it("bounds declared and streamed payloads before business persistence", async () => {
    const h = harness();
    expect(
      (
        await h.app.request("/v1/workspace/business", {
          method: "POST",
          headers: { ...headers, "content-length": String(133 * 1024) },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (chunks > 100) controller.close();
      },
    });
    const streamed = await h.app.request("/v1/workspace/business", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(chunks).toBeLessThan(15);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
describe("Business catalog, lifecycle and next-step conformance", () => {
  it("keeps public context, HTTP and MCP schemas aligned and retires old routes and aliases", async () => {
    const h = harness();
    for (const task of [
      "business",
      "targeting",
      "research-criteria",
      "commercial-voice",
      "setup",
    ]) {
      const context = getAgentContext(task)!;
      expect(context.revision).toMatch(/^sha256:/);
      expect(JSON.stringify(context)).not.toMatch(
        /Apollo|Unipile|HeyReach|Smartlead|Mailivery|lifty-local-submission|onboarding_state|section.*icp/,
      );
      for (const [action, operation] of Object.entries(context.operations!)) {
        if (operation.responses["405"]) {
          expect(
            (await h.request(operation.route, operation.method)).status,
          ).toBe(405);
          continue;
        }
        const name = `${task.replace(/-/g, "_")}_${action}`;
        const tool = getStageMcpTools().find((item) => item.name === name);
        expect(tool).toBeDefined();
        expect(context.instructions).toContain(name);
      }
    }
    for (const path of [
      "/v1/onboarding",
      "/v1/onboarding/state",
      "/v1/config",
      "/v1/config/context",
      "/v1/workspace",
      "/v1/workspaces/22222222-2222-4222-8222-222222222222/integrations/apollo/key-source",
    ]) {
      const response = await h.request(path, "POST", {});
      expect(response.status, path).toBe(404);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(getStageMcpTools().map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "setup_get_draft",
        "setup_patch_draft",
        "setup_delete_draft",
        "setup_generation_context",
        "account_delete",
      ]),
    );
  });
  it("returns identical repair issues through MCP and forwards selected workspace", async () => {
    const h = harness();
    const request = new Request("https://api.test/mcp", {
      headers: { ...headers, "x-lifty-workspace": "example" },
    });
    const bad = {
      expected_version: 1,
      offerings: [{ text: "x", provenance: "inferred" }],
    };
    const direct = await (
      await h.request("/v1/workspace/business", "PATCH", bad)
    ).json();
    const tool = await callStageMcpTool(
      "business_patch",
      { body: bad },
      request,
      (route, init) => Promise.resolve(h.app.request(route, init)),
    );
    expect(tool.structuredContent).toMatchObject({
      status: 422,
      data: { error: direct.error },
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("uses confirmed profile and resource state to bypass an absent old onboarding receipt", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => ({ state: "none" }),
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      step: "sample-review",
      reason: "sample_not_started",
      gates: null,
      saved: null,
    });
    const resumed = await (await h.request("/v1/workspace/next-step")).json();
    expect(resumed.actions[0]).toContain("sample_review_post with body {}");
    expect(resumed.actions.join("\n")).not.toContain(
      "only after the founder asks",
    );
    expect(resumed.guide.task).toBe("step-sample");
    expect(h.rpc.mock.calls.map(([name]) => name).slice(0, 4)).toEqual([
      "get_lifty_business_profile",
      "get_lifty_targeting",
      "get_lifty_research_criteria",
      "get_lifty_setup_status",
    ]);
  });
  it("never interprets a failed resource read as missing setup", async () => {
    const h = harness(undefined, {
      code: "XX000",
      message: "private provider failure",
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider failure");
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("keeps Business checkpoint until confirmation and reports suspended lifecycle without new work", async () => {
    const h = harness({
      ...get,
      profile: {
        ...profileFixture,
        confirmation: { complete: false, missing: ["offerings"] },
      },
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(await response.json()).toMatchObject({
      step: "business",
      reason: "business_confirmation_needed",
    });
    expect(h.rpc).toHaveBeenCalledOnce();
    const retired = harness({
      ...get,
      workspace: { ...identity, state: "suspended" },
    });
    expect(
      await (await retired.request("/v1/workspace/next-step")).json(),
    ).toMatchObject({ state: "blocked", reason: "workspace_suspended" });
    expect(retired.rpc).toHaveBeenCalledOnce();
  });
});

const runFixture = {
  state: "succeeded" as const,
  run_ref: "run-1",
  requested_leads: 5,
  leads_discovered: 5,
  leads_researched: 4,
  error_code: null,
  started_at: profileFixture.updated_at,
  completed_at: profileFixture.updated_at,
  workspace: { workspace_ref: workspaceRef, name: "Example" },
  leads: [],
};
const campaignFixture = {
  workspace_ref: workspaceRef,
  state: "unconfigured" as const,
  outreach_enabled: false,
  version_ref: null,
  digest: null,
  configuration: null,
  continuing_versions: [],
  blocked_leads: [],
  eligible_count: 0,
  progress: { enrolled: 0, blocked: 0, completed: 0 },
  previews: [],
  blockers: [],
};
const campaignExample = JSON.parse(
  [
    ...getAgentContext("campaign")!.instructions.matchAll(
      /```json\n([\s\S]*?)\n```/g,
    ),
  ][0]![1]!,
);
const sharedCampaignFixture = {
  ...campaignExample.request.payload.configuration,
  audience: {
    policy: "qualified_ab_v1",
    lead_ids: null,
    includes_future_leads: true,
  },
  linkedin: {
    ...campaignExample.request.payload.configuration.linkedin,
    sender: "https://www.linkedin.com/in/founder",
    timezone: "America/Argentina/Buenos_Aires",
    invitation_note: null,
  },
  email: null,
  not_before: null,
  stop_on_reply: true,
};
const crmConnected = {
  provider: "hubspot" as const,
  status: "connected" as const,
  portal_id: "123",
  hub_domain: null,
  granted_scopes: [],
  connected_at: null,
  reconnect_required: false,
};
const syncFixture = {
  state: "running" as const,
  run_ref: "sync-1",
  requested_leads: 4,
  leads_synced: 1,
  error_code: null,
  portal_id: "123",
  started_at: profileFixture.updated_at,
  completed_at: null,
  workspace: runFixture.workspace,
};
const emailFixture = {
  provider: "unipile" as const,
  channel: "email" as const,
  workspace_ref: workspaceRef,
  status: "connected" as const,
  email: "founder@example.test",
  mailbox_use: "personal" as const,
  daily_limit: 10,
  warmup_required: false,
  sending_enabled: false as const,
  connection_ref: laneFixture.id,
  intent_ref: null,
  failure_code: null,
};
const summaryReads: Partial<AppDependencies> = {
  getWorkspace: async () => ({
    state: "ready_for_connections",
    workspace: runFixture.workspace,
    next_action: null,
  }),
  getRunStatus: async () => runFixture,
  workspaceCampaign: async () => campaignFixture,
  getHubspotConnection: async () => crmConnected,
  getCrmSyncStatus: async () => syncFixture,
  getEmailConnection: async () => emailFixture,
  getLinkedinConnection: async () => ({
    provider: "unipile",
    channel: "linkedin",
    workspace_ref: workspaceRef,
    status: "not_connected",
  }),
};

describe("resource resumption preserves research, campaign and CRM decisions", () => {
  it.each(["queued", "running", "failed"] as const)(
    "resumes a %s research receipt without starting a run or reading a campaign",
    async (state) => {
      const campaign = vi.fn(async () => campaignFixture);
      const start = vi.fn();
      const h = harness(undefined, null, {
        getRunStatus: async () => ({
          ...runFixture,
          state,
          completed_at: state === "failed" ? profileFixture.updated_at : null,
          error_code: state === "failed" ? "research_unavailable" : null,
        }),
        workspaceCampaign: campaign,
        startRun: start,
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        step: "sample-review",
        state: state === "failed" ? "blocked" : "pending",
        receipt: { run_ref: "run-1" },
      });
      if (state !== "failed")
        expect(result.actions[0]).toContain("run_ref run-1");
      expect(campaign).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["draft", "pending", "pending", "campaign_preparing"],
    ["draft", "failed", "blocked", "campaign_preparation_failed"],
    ["draft", "ready", "action_required", "campaign_draft"],
    ["paused", "ready", "action_required", "campaign_paused"],
    ["active", "ready", "complete", "campaign_active"],
  ] as const)(
    "resumes campaign %s/%s with no activation",
    async (state, preparation, expected, reason) => {
      const campaign = vi.fn(async () => ({
        ...campaignFixture,
        configuration: sharedCampaignFixture,
        state,
        outreach_enabled: state === "active",
        version_ref: laneFixture.id,
        digest: "a".repeat(64),
        preparation: {
          state: preparation,
          errors: preparation === "failed" ? ["render_failed"] : [],
        },
        blockers: state === "draft" ? ["sender_not_connected"] : [],
      }));
      const h = harness(undefined, null, {
        getRunStatus: async () => runFixture,
        workspaceCampaign: campaign,
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        step: "campaign",
        state: expected,
        reason,
        receipt: { version_ref: laneFixture.id, preparation },
      });
      expect(JSON.stringify(result).length).toBeLessThan(80000);
      expect(campaign).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userId: "founder" }),
        { operation: "status", payload: { workspace: workspaceRef } },
      );
    },
  );
  it.each(["campaign", "run"])(
    "fails closed for a foreign %s instead of inferring missing configuration",
    async (component) => {
      const foreign = "55555555-5555-4555-8555-555555555555";
      const h = harness(undefined, null, {
        getRunStatus: async () =>
          component === "run"
            ? {
                ...runFixture,
                workspace: { ...runFixture.workspace, workspace_ref: foreign },
              }
            : runFixture,
        workspaceCampaign: async () => ({
          ...campaignFixture,
          workspace_ref: foreign,
        }),
      });
      const response = await h.request("/v1/workspace/next-step");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(foreign);
    },
  );
  it("keeps unreadable campaign state unavailable instead of calling it unconfigured", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => runFixture,
      workspaceCampaign: async () => {
        throw new PublicError({
          status: 502,
          code: "WORKSPACE_CAMPAIGN_UNAVAILABLE",
          message: "Campaign status unavailable.",
        });
      },
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(
      "sample_ready_for_founder_review",
    );
  });
  it.each([
    [
      { status: "not_connected", provider: "hubspot" },
      { state: "none" },
      "Ask once whether",
    ],
    [
      { ...crmConnected, reconnect_required: true },
      { state: "none" },
      "needs reconnecting",
    ],
    [crmConnected, { state: "none" }, "nothing is synced yet"],
    [crmConnected, syncFixture, "in progress (run_ref sync-1)"],
    [
      crmConnected,
      {
        ...syncFixture,
        state: "succeeded",
        completed_at: profileFixture.updated_at,
        leads_synced: 4,
      },
      "finished (4 leads)",
    ],
    [
      crmConnected,
      {
        ...syncFixture,
        state: "failed",
        completed_at: profileFixture.updated_at,
        error_code: "portal_scope_missing",
      },
      "failed (portal_scope_missing)",
    ],
  ] as const)(
    "offers a CRM action from saved evidence without blocking leads-only review",
    async (connection, sync, message) => {
      const write = vi.fn();
      const h = harness(undefined, null, {
        getRunStatus: async () => runFixture,
        workspaceCampaign: async () => campaignFixture,
        getHubspotConnection: async () => connection as never,
        getCrmSyncStatus: async () => sync as never,
        startCrmSyncRun: write,
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        state: "review",
        reason: "sample_ready_for_founder_review",
        section: "leads",
      });
      expect(result.actions[2]).toContain(message);
      expect(result.actions[3]).toContain(
        "Close Section 1 in at most six lines",
      );
      expect(result.actions[3]).toContain("set up LinkedIn outreach now");
      expect(result.guide).toMatchObject({ task: "step-review" });
      expect(result.guide.instructions).toContain('If "not now", accept');
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("preserves leads-only review through optional CRM failures and never claims a new connection is needed", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => runFixture,
      workspaceCampaign: async () => campaignFixture,
      getHubspotConnection: async () => {
        throw Error("secret credential");
      },
    });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result.state).toBe("review");
    expect(result.actions[2]).toContain("currently unavailable");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("summary keeps independent tenant-scoped state", () => {
  it("reports resource versions, research and CRM receipts without full lead or message content", async () => {
    const h = harness(undefined, null, summaryReads);
    const response = await h.request("/v1/workspace/summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      setup: {
        status: "available",
        value: {
          targeting_version: 1,
          criteria_version: 1,
          profile_version: 1,
          voice_version: 0,
        },
      },
      run: {
        status: "available",
        value: { state: "succeeded", leads_researched: 4 },
      },
      crm: {
        status: "available",
        value: {
          connected: true,
          sync_pending: true,
          last_sync: { state: "running", leads_synced: 1 },
        },
      },
      email: { status: "available", value: { sending_enabled: false } },
      linkedin: {
        status: "available",
        value: { connection_status: "not_connected" },
      },
    });
    expect(result).not.toHaveProperty("config_update");
    expect(result).not.toHaveProperty("onboarding");
    expect(result.run.value).not.toHaveProperty("leads");
  });
  it("keeps unrelated reads available when research, email ownership or voice cannot be read", async () => {
    const h = harness(undefined, null, {
      ...summaryReads,
      getRunStatus: async () => {
        throw Error("secret research error");
      },
      getEmailConnection: async () => {
        throw new PublicError({
          status: 409,
          code: "EMAIL_ACCOUNT_TAKEN",
          message: "Secret ownership detail",
        });
      },
    });
    const result = await (await h.request("/v1/workspace/summary")).json();
    expect(result.run).toEqual({
      status: "unavailable",
      next_action: "retry_read",
    });
    expect(result.email).toEqual({
      status: "unavailable",
      next_action: "retry_read",
    });
    expect(result.crm.status).toBe("available");
    expect(result.business.status).toBe("available");
    expect(JSON.stringify(result)).not.toMatch(/Secret|secret/);
  });
  it.each([401, 403])(
    "does not hide authorization %s inside a partial summary",
    async (status) => {
      const h = harness(undefined, null, {
        ...summaryReads,
        getRunStatus: async () => {
          throw new PublicError({ status, code: "DENIED", message: "Denied" });
        },
      });
      expect((await h.request("/v1/workspace/summary")).status).toBe(status);
    },
  );
  it.each([
    "WORKSPACE_CHANGED",
    "WORKSPACE_UNAVAILABLE",
    "WORKSPACE_MISSING",
    "WORKSPACE_SELECTION_REQUIRED",
    "WORKSPACE_SUSPENDED",
  ])("does not hide scope conflict %s", async (code) => {
    const h = harness(undefined, null, {
      ...summaryReads,
      getRunStatus: async () => {
        throw new PublicError({
          status: 409,
          code,
          message: "Refresh workspace state.",
        });
      },
    });
    expect((await h.request("/v1/workspace/summary")).status).toBe(409);
  });
  it.each(["run", "crm", "email"])(
    "rejects foreign %s state while summarizing a selected workspace",
    async (component) => {
      const foreign = "55555555-5555-4555-8555-555555555555";
      const h = harness(undefined, null, {
        ...summaryReads,
        ...(component === "run"
          ? {
              getRunStatus: async () => ({
                ...runFixture,
                workspace: { ...runFixture.workspace, workspace_ref: foreign },
              }),
            }
          : component === "crm"
            ? {
                getCrmSyncStatus: async () => ({
                  ...syncFixture,
                  workspace: {
                    ...runFixture.workspace,
                    workspace_ref: foreign,
                  },
                }),
              }
            : {
                getEmailConnection: async () => ({
                  ...emailFixture,
                  workspace_ref: foreign,
                }),
              }),
      });
      expect((await h.request("/v1/workspace/summary")).status).toBe(403);
    },
  );
  it("rejects membership changes between aggregate reads", async () => {
    const getWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        state: "ready_for_connections",
        workspace: runFixture.workspace,
        next_action: null,
      })
      .mockResolvedValue({
        state: "ready_for_connections",
        workspace: {
          workspace_ref: "55555555-5555-4555-8555-555555555555",
          name: "Foreign",
        },
        next_action: null,
      });
    const h = harness(undefined, null, { ...summaryReads, getWorkspace });
    expect((await h.request("/v1/workspace/summary")).status).toBe(409);
  });
  it("reads a selected client roster instead of a founder mailbox", async () => {
    const email = vi.fn();
    const sender = laneFixture.id;
    const accounts = vi.fn(async () => ({
      workspace_ref: workspaceRef,
      workspace_slug: "example",
      senders: [{ sender_ref: sender, display_name: "David" }],
      accounts: [
        {
          connection_ref: laneFixture.personas[0]!.id,
          sender_ref: sender,
          email: "david@example.test",
          status: "connected" as const,
          campaign_send_paused: true,
        },
      ],
      campaign_release_required: true as const,
      required_active_days: 21 as const,
    }));
    const h = harness(undefined, null, {
      ...summaryReads,
      listMemberWorkspaces: async () => ({
        workspaces: [{ ...membershipFixture, self_service: false }],
      }),
      getEmailConnection: email,
      getEmailAccounts: accounts,
    });
    const result = await (
      await h.request("/v1/workspace/summary", "GET", undefined, {
        "x-lifty-workspace": "example",
      })
    ).json();
    expect(result).toMatchObject({
      self_service: false,
      email: null,
      mailboxes: {
        status: "available",
        value: {
          senders: 1,
          accounts: [{ sender_name: "David", email: "david@example.test" }],
        },
      },
    });
    expect(email).not.toHaveBeenCalled();
    expect(accounts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "founder" }),
      { workspace: workspaceRef },
    );
  });
  it("rejects aggregate writes and missing authorization", async () => {
    const h = harness(undefined, null, summaryReads);
    for (const method of ["POST", "PATCH"])
      expect(
        (await h.request("/v1/workspace/summary", method, {})).status,
      ).toBe(405);
    expect((await createApp().request("/v1/workspace/summary")).status).toBe(
      401,
    );
  });
});
