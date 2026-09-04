import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { ConfigUpdateStatus, ConfigUpdateSubmission } from "../src/contracts.js";

const session = { userId: "founder-123", client: { kind: "scoped" } };
const authenticate = async () => ({ ok: true as const, session });
const authorized = { authorization: "Bearer valid-token" };
const SUBMISSION_REF = "44444444-4444-4444-8444-444444444444";

const configFixture = {
  workspace_ref: "ws_opaque",
  config: {
    icp: {
      version: 2,
      digest: `sha256:${"a".repeat(64)}`,
      label: "Example lane",
      person_locations: ["Canada"],
      organization_industries: ["computer software"],
      organization_num_employees_ranges: ["51,200"],
      person_seniorities: null,
      contact_email_status: "verified",
      q_organization_domains_list: null,
      q_keywords: null,
      personas: [{ name: "Finance", titles: ["CFO"] }],
      max_stale_days: 90,
      reject_extrapolated: true,
    },
    tone: { version: `sha256:${"b".repeat(64)}`, values: { identity: "Clear and direct" } },
    prompt: {
      version: "2026-09-02T20:00:00.000000Z",
      digest: `sha256:${"c".repeat(64)}`,
      source: "lif667_config_update",
      text: "## ICP gate\nMid-market manufacturers.",
    },
    workspace: {
      version: `sha256:${"d".repeat(64)}`,
      name: "Example",
      description: null,
      daily_discovery_target: 30,
    },
  },
};

const submissionFixture = (
  overrides: Partial<ConfigUpdateSubmission> = {},
): ConfigUpdateSubmission => ({
  state: "queued",
  submission_ref: SUBMISSION_REF,
  run_ref: SUBMISSION_REF,
  import_status: "pending",
  changed_sections: ["tone"],
  artifact_actions: { icp: "none", tone: "applied", prompt: "regenerate", workspace: "none" },
  regenerate_icp: false,
  regenerate_prompt: true,
  workspace_ref: "ws_opaque",
  created: true,
  ...overrides,
});

const statusFixture: ConfigUpdateStatus = {
  state: "applied",
  submission_ref: SUBMISSION_REF,
  import_status: "imported",
  run_ref: null,
  changed_sections: ["tone"],
  artifact_actions: { icp: "none", tone: "applied", prompt: "regenerate", workspace: "none" },
  regenerate_icp: false,
  regenerate_prompt: true,
  icp_version: 2,
  prompt_chars: 1234,
  prompt_version: "2026-09-02T20:00:00.000000Z",
  error_code: null,
  requeued_at: null,
  submitted_at: "2026-09-02T19:59:00Z",
  updated_at: "2026-09-02T20:00:00Z",
  workspace: { workspace_ref: "ws_opaque", name: "Example" },
};

describe("LIFTY API workspace management (P6)", () => {
  it("publishes the P6 endpoints in the OpenAPI contract", async () => {
    const document = await (await createApp().request("/openapi.json")).json() as {
      paths?: Record<string, Record<string, { operationId?: string }>>;
    };
    const operation = (path: string, method: string) =>
      document.paths?.[path]?.[method]?.operationId;

    expect(operation("/v1/status", "get")).toBe("getStatus");
    expect(operation("/v1/config", "get")).toBe("getConfig");
    expect(operation("/v1/config", "patch")).toBe("updateConfig");
    expect(operation("/v1/config/{section}", "get")).toBe("getConfigSection");
    expect(operation("/v1/config/updates/{submission_ref}", "get")).toBe(
      "getConfigUpdateStatus",
    );
    expect(operation("/v1/integrations/{provider}", "get")).toBe("getProviderConnection");
    expect(operation("/v1/integrations/{provider}", "delete")).toBe("disconnectProvider");
    expect(operation("/v1/integrations/{provider}/connect", "post")).toBe(
      "startProviderConnect",
    );
    expect(operation("/v1/integrations/{provider}/sync", "post")).toBe("startCrmSync");
    expect(operation("/v1/integrations/{provider}/sync", "get")).toBe("getCrmSyncStatus");
  });

  it("aggregates status in one call and never touches OAuth", async () => {
    const historicalUpdate: ConfigUpdateStatus = {
      ...statusFixture,
      changed_sections: ["icp"],
      artifact_actions: { icp: "applied", tone: "none", prompt: "none", workspace: "none" },
      icp_version: 9,
    };
    const app = createApp({
      authenticate,
      getWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        next_action: null,
      }),
      getOnboardingStatus: async () => ({
        state: "imported",
        submission_ref: "11111111-1111-4111-8111-111111111111",
        draft_digest: `sha256:${"a".repeat(64)}`,
        submitted_at: "2026-09-01T21:00:00Z",
        error_code: null,
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        summary: { icp: null, prompt: null },
      }),
      getRunStatus: async () => ({
        state: "succeeded",
        run_ref: "22222222-2222-4222-8222-222222222222",
        requested_leads: 5,
        leads_discovered: 5,
        leads_researched: 5,
        error_code: null,
        started_at: "2026-09-01T21:00:00Z",
        completed_at: "2026-09-01T21:20:00Z",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        leads: [{
          name: "Ada Lovelace",
          title: "CFO",
          company: "Example",
          linkedin_url: null,
          tier: "A",
          fit_rationale: "matches",
          stage: "qualified",
        }],
      }),
      getCrmSyncStatus: async () => ({
        state: "succeeded",
        run_ref: "33333333-3333-4333-8333-333333333333",
        requested_leads: 4,
        leads_synced: 4,
        error_code: null,
        portal_id: "149239526",
        started_at: "2026-09-02T14:00:00Z",
        completed_at: "2026-09-02T14:05:00Z",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
      }),
      getHubspotConnection: async () => ({
        provider: "hubspot",
        status: "connected",
        portal_id: "149239526",
        hub_domain: "example.hubspot.com",
        granted_scopes: ["oauth"],
        connected_at: "2026-09-02T10:00:00Z",
        reconnect_required: false,
      }),
      getConfig: async (_session, section) => {
        expect(section).toBe("icp");
        return {
          ...configFixture,
          config: {
            icp: { ...configFixture.config.icp, version: 10 },
          },
        };
      },
      getConfigUpdateStatus: async (_session, ref) => {
        expect(ref).toBeNull();
        return historicalUpdate;
      },
      // Any OAuth attempt would hit the unconfigured default and 500.
    });

    const response = await app.request("/v1/status", { headers: authorized });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace: { state: "ready_for_connections", workspace_ref: "ws_opaque", name: "Example" },
      onboarding: {
        state: "imported",
        submission_ref: "11111111-1111-4111-8111-111111111111",
        submitted_at: "2026-09-01T21:00:00Z",
        error_code: null,
      },
      configuration: { icp_version: 10 },
      run: {
        state: "succeeded",
        run_ref: "22222222-2222-4222-8222-222222222222",
        requested_leads: 5,
        leads_discovered: 5,
        leads_researched: 5,
        error_code: null,
        started_at: "2026-09-01T21:00:00Z",
        completed_at: "2026-09-01T21:20:00Z",
      },
      config_update: historicalUpdate,
      integrations: {
        hubspot: {
          available: true,
          connected: true,
          portal_id: "149239526",
          hub_domain: "example.hubspot.com",
          connected_at: "2026-09-02T10:00:00Z",
          reconnect_required: false,
          sync_pending: false,
          last_sync_at: "2026-09-02T14:05:00Z",
          last_sync: {
            state: "succeeded",
            run_ref: "33333333-3333-4333-8333-333333333333",
            requested_leads: 4,
            leads_synced: 4,
            error_code: null,
            started_at: "2026-09-02T14:00:00Z",
            completed_at: "2026-09-02T14:05:00Z",
          },
        },
        unipile: { available: false, connected: false },
      },
    });
  });

  it("reports a running sync as pending and a missing connection as not connected", async () => {
    const app = createApp({
      authenticate,
      getWorkspace: async () => ({
        state: "suspended",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        next_action: null,
      }),
      getOnboardingStatus: async () => ({ state: "none" }),
      getRunStatus: async () => ({ state: "none" }),
      getCrmSyncStatus: async () => ({
        state: "running",
        run_ref: "33333333-3333-4333-8333-333333333333",
        requested_leads: 4,
        leads_synced: 1,
        error_code: null,
        portal_id: null,
        started_at: "2026-09-02T14:00:00Z",
        completed_at: null,
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
      }),
      getHubspotConnection: async () => ({ provider: "hubspot", status: "not_connected" }),
      getConfig: async () => configFixture,
      getConfigUpdateStatus: async () => ({ state: "none" }),
    });

    const body = await (await app.request("/v1/status", { headers: authorized })).json() as {
      workspace: { state: string };
      integrations: { hubspot: { connected: boolean; sync_pending: boolean; last_sync_at: string | null } };
    };

    expect(body.workspace.state).toBe("suspended");
    expect(body.integrations.hubspot.connected).toBe(false);
    expect(body.integrations.hubspot.sync_pending).toBe(true);
    expect(body.integrations.hubspot.last_sync_at).toBeNull();
  });

  it("short-circuits status when the account has no workspace yet", async () => {
    const app = createApp({
      authenticate,
      getWorkspace: async () => ({
        state: "needs_workspace",
        workspace: null,
        next_action: "provision_workspace",
      }),
      getHubspotConnection: async () => {
        throw new Error("must not be called without a workspace");
      },
    });

    const response = await app.request("/v1/status", { headers: authorized });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspace: { state: "needs_workspace" },
      onboarding: { state: "none" },
      configuration: { icp_version: null },
      run: { state: "none" },
      config_update: { state: "none" },
      integrations: { hubspot: { connected: false }, unipile: { connected: false } },
    });
  });

  it("returns the full config and a single, case-insensitive section", async () => {
    const sections: Array<string | null> = [];
    const app = createApp({
      authenticate,
      getConfig: async (_session, section) => {
        sections.push(section);
        return configFixture;
      },
    });

    const full = await app.request("/v1/config", { headers: authorized });
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual(configFixture);

    const prompt = await app.request("/v1/config/PROMPT", { headers: authorized });
    expect(prompt.status).toBe(200);
    expect(sections).toEqual([null, "prompt"]);
  });

  it("rejects an unknown config section before business logic", async () => {
    const app = createApp({
      authenticate,
      getConfig: async () => {
        throw new Error("must not be called");
      },
    });

    const response = await app.request("/v1/config/secrets", { headers: authorized });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("queues a regenerating update and enqueues exactly one job", async () => {
    const enqueueCalls: Array<{ submissionId: string; requeuedAt: string | null }> = [];
    const app = createApp({
      authenticate,
      submitConfigUpdate: async (received, payload) => {
        expect(received.userId).toBe("founder-123");
        expect(payload).toEqual({ section: "tone", values: { identity: "Clear and direct" } });
        return submissionFixture();
      },
      enqueueConfigUpdate: async (submissionId, options) => {
        enqueueCalls.push({ submissionId, requeuedAt: options.requeuedAt });
        return { id: "run_cfg" };
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "tone", values: { identity: "Clear and direct" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "queued",
      submission_ref: SUBMISSION_REF,
      run_ref: SUBMISSION_REF,
      import_status: "pending",
      changed_sections: ["tone"],
      artifact_actions: { icp: "none", tone: "applied", prompt: "regenerate", workspace: "none" },
      workspace_ref: "ws_opaque",
      created: true,
      icp_version: null,
      prompt_chars: null,
      prompt_version: null,
      error_code: null,
    });
    expect(enqueueCalls).toEqual([{ submissionId: SUBMISSION_REF, requeuedAt: null }]);
  });

  it("applies a direct write synchronously without enqueuing", async () => {
    let enqueued = false;
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () =>
        submissionFixture({
          state: "applied",
          run_ref: null,
          import_status: "imported",
          changed_sections: ["workspace"],
          artifact_actions: { icp: "none", tone: "none", prompt: "none", workspace: "applied" },
          regenerate_prompt: false,
        }),
      enqueueConfigUpdate: async () => {
        enqueued = true;
        return { id: "run_must_not_exist" };
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "workspace", values: { name: "Renamed" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "applied", run_ref: null });
    expect(enqueued).toBe(false);
  });

  it("reads the new lane version back after a synchronous filter-only write", async () => {
    const sections: Array<string | null> = [];
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () =>
        submissionFixture({
          state: "applied",
          run_ref: null,
          import_status: "imported",
          changed_sections: ["icp"],
          artifact_actions: { icp: "applied", tone: "none", prompt: "none", workspace: "none" },
          regenerate_prompt: false,
        }),
      getConfig: async (_session, section) => {
        sections.push(section);
        return configFixture;
      },
      enqueueConfigUpdate: async () => {
        throw new Error("must not enqueue a synchronous write");
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "icp", values: { person_locations: ["Canada"] } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "applied", icp_version: 2 });
    expect(sections).toEqual(["icp"]);
  });

  it("re-runs a previously failed regeneration keyed on the requeue stamp", async () => {
    const enqueueCalls: Array<{ requeuedAt: string | null }> = [];
    const order: string[] = [];
    const app = createApp({
      authenticate,
      requeueConfigUpdate: async (_session, ref) => {
        order.push(`requeue:${ref}`);
        return {
          ...statusFixture,
          state: "queued",
          import_status: "pending",
          run_ref: SUBMISSION_REF,
          requeued_at: "2026-09-03T06:53:00Z",
        };
      },
      submitConfigUpdate: async () =>
        submissionFixture({
          state: "failed",
          run_ref: null,
          import_status: "failed",
          created: false,
          error_code: "agent_timeout",
        }),
      enqueueConfigUpdate: async (submissionId, options) => {
        order.push(`enqueue:${submissionId}`);
        enqueueCalls.push({ requeuedAt: options.requeuedAt });
        return { id: "run_retry" };
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "prompt", instruction: "Emphasize urgency." }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "queued",
      run_ref: SUBMISSION_REF,
      error_code: null,
      created: false,
    });
    expect(enqueueCalls).toEqual([{ requeuedAt: "2026-09-03T06:53:00Z" }]);
    // The row is reset before the job is triggered, never after.
    expect(order).toEqual([`requeue:${SUBMISSION_REF}`, `enqueue:${SUBMISSION_REF}`]);
  });

  it("does not requeue a still-pending replay; it only re-enqueues idempotently", async () => {
    let requeued = false;
    const enqueueCalls: Array<{ requeuedAt: string | null }> = [];
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () => submissionFixture({ created: false }),
      requeueConfigUpdate: async () => {
        requeued = true;
        throw new Error("must not requeue a pending submission");
      },
      enqueueConfigUpdate: async (_submissionId, options) => {
        enqueueCalls.push({ requeuedAt: options.requeuedAt });
        return { id: "run_same" };
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "tone", values: { identity: "Clear" } }),
    });

    expect(response.status).toBe(200);
    expect(requeued).toBe(false);
    expect(enqueueCalls).toEqual([{ requeuedAt: null }]);
  });

  it("accepts RPC results that omit error_code and requeued_at (pre-LIF-681 shape)", async () => {
    const { error_code: _omittedError, ...onboardingWithoutErrorCode } = {
      state: "imported" as const,
      submission_ref: "11111111-1111-4111-8111-111111111111",
      draft_digest: `sha256:${"a".repeat(64)}`,
      submitted_at: "2026-09-01T21:00:00Z",
      error_code: null,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      summary: { icp: null, prompt: null },
    };
    const { requeued_at: _omittedRequeue, ...statusWithoutRequeue } = statusFixture;
    const app = createApp({
      authenticate,
      getWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        next_action: null,
      }),
      getOnboardingStatus: async () => onboardingWithoutErrorCode,
      getRunStatus: async () => ({ state: "none" }),
      getCrmSyncStatus: async () => ({ state: "none" }),
      getHubspotConnection: async () => ({ provider: "hubspot", status: "not_connected" }),
      getConfig: async () => configFixture,
      getConfigUpdateStatus: async () => statusWithoutRequeue,
    });

    const response = await app.request("/v1/status", { headers: authorized });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      onboarding: { state: "imported", error_code: null },
      config_update: { state: "applied" },
    });
  });

  it("re-attaches to a requeued-but-still-pending submission with the same retry key", async () => {
    // requeue succeeded earlier but the enqueue was lost: the re-send must
    // reuse the requeue stamp, not the original key (which dedupes onto the
    // dead run inside the idempotency TTL).
    const enqueueCalls: Array<{ requeuedAt: string | null }> = [];
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () =>
        submissionFixture({ created: false, requeued_at: "2026-09-03T06:53:00Z" }),
      requeueConfigUpdate: async () => {
        throw new Error("must not requeue a pending submission");
      },
      enqueueConfigUpdate: async (_submissionId, options) => {
        enqueueCalls.push({ requeuedAt: options.requeuedAt });
        return { id: "run_retry_again" };
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ section: "prompt", instruction: "Emphasize urgency." }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "queued", created: false });
    expect(enqueueCalls).toEqual([{ requeuedAt: "2026-09-03T06:53:00Z" }]);
  });

  it("never serializes fields beyond the config update contract", async () => {
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () => ({
        ...submissionFixture({ state: "applied", run_ref: null, import_status: "imported", regenerate_prompt: false }),
        request_digest: `sha256:${"e".repeat(64)}`,
        section_digests: { icp: "x" },
        desired_config: { prompt: { text: "never" } },
        access_token: "never",
      }),
    });

    const body = await (await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ values: { workspace: { name: "Renamed" } } }),
    })).json() as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "artifact_actions",
      "changed_sections",
      "created",
      "error_code",
      "icp_version",
      "import_status",
      "prompt_chars",
      "prompt_version",
      "run_ref",
      "state",
      "submission_ref",
      "workspace_ref",
    ]);
  });

  it.each([
    ["missing instruction", { section: "prompt" }],
    ["missing values", { section: "icp" }],
    ["lane weight masquerading as target", { section: "icp", values: { daily_target: 30 } }],
    ["lane label edit", { section: "icp", values: { label: "Collapsed lane" } }],
    ["target hidden in a full update", { values: { icp: { daily_target: 30 } } }],
    ["empty body", {}],
    ["unknown section", { section: "secrets", values: { a: 1 } }],
    ["not json", "not json"],
  ])("rejects a malformed config update (%s)", async (_label, payload) => {
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () => {
        throw new Error("must not be called");
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: { ...authorized, "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a declared oversized config update before reading it", async () => {
    const app = createApp({
      authenticate,
      submitConfigUpdate: async () => {
        throw new Error("must not be called");
      },
    });

    const response = await app.request("/v1/config", {
      method: "PATCH",
      headers: {
        ...authorized,
        "content-type": "application/json",
        "content-length": String(200 * 1024),
      },
      body: JSON.stringify({ values: { tone: { identity: "x" } } }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("returns a config update status by reference and validates the reference", async () => {
    const refs: Array<string | null> = [];
    const app = createApp({
      authenticate,
      getConfigUpdateStatus: async (_session, ref) => {
        refs.push(ref);
        return statusFixture;
      },
    });

    const ok = await app.request(`/v1/config/updates/${SUBMISSION_REF}`, { headers: authorized });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(statusFixture);

    const bad = await app.request("/v1/config/updates/not-a-uuid", { headers: authorized });
    expect(bad.status).toBe(400);
    expect(refs).toEqual([SUBMISSION_REF]);
  });

  it("disconnects a provider through the authenticated session", async () => {
    const app = createApp({
      authenticate,
      disconnectIntegration: async (received, provider) => {
        expect(received.userId).toBe("founder-123");
        expect(provider).toBe("hubspot");
        return {
          provider: "hubspot",
          status: "disconnected",
          portal_id: "149239526",
          disconnected_at: "2026-09-02T21:00:00Z",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
        };
      },
    });

    const response = await app.request("/v1/integrations/HubSpot", {
      method: "DELETE",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "hubspot",
      status: "disconnected",
      portal_id: "149239526",
      disconnected_at: "2026-09-02T21:00:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
    });
  });

  const disconnectedFixture = {
    provider: "hubspot" as const,
    status: "disconnected" as const,
    portal_id: "149239526",
    disconnected_at: "2026-09-02T21:00:00Z",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
  };
  const REVOCATION_REF = "681a0000-0000-4000-a000-000000000001";

  it("enqueues the provider-side revocation for a detached grant without exposing it (LIF-681)", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate,
      disconnectIntegration: async () => ({ ...disconnectedFixture, revocation_ref: REVOCATION_REF }),
      enqueueIntegrationRevocation: async (revocationId) => {
        enqueued.push(revocationId);
        return { id: "run_revoke" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot", {
      method: "DELETE",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(disconnectedFixture);
    expect(enqueued).toEqual([REVOCATION_REF]);
  });

  it("does not enqueue a revocation when the RPC had no grant to detach", async () => {
    let enqueued = false;
    const app = createApp({
      authenticate,
      disconnectIntegration: async () => ({ ...disconnectedFixture, revocation_ref: null }),
      enqueueIntegrationRevocation: async () => {
        enqueued = true;
        return { id: "run_must_not_exist" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot", {
      method: "DELETE",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    expect(enqueued).toBe(false);
  });

  it("still reports the disconnect when the revocation enqueue fails, and logs it", async () => {
    const events: unknown[] = [];
    const app = createApp({
      authenticate,
      disconnectIntegration: async () => ({ ...disconnectedFixture, revocation_ref: REVOCATION_REF }),
      enqueueIntegrationRevocation: async () => {
        throw new Error("trigger down");
      },
      log: (event) => events.push(event),
    });

    const response = await app.request("/v1/integrations/hubspot", {
      method: "DELETE",
      headers: authorized,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(disconnectedFixture);
    expect(events).toEqual([
      expect.objectContaining({
        level: "error",
        event: "revocation_enqueue_failed",
        path: "/v1/integrations/hubspot",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(REVOCATION_REF);
  });

  it.each([
    ["GET", "/v1/integrations/salesforce"],
    ["DELETE", "/v1/integrations/salesforce"],
    ["POST", "/v1/integrations/salesforce/connect"],
    ["POST", "/v1/integrations/salesforce/sync"],
    ["GET", "/v1/integrations/salesforce/sync"],
  ])("rejects an unknown provider on %s %s", async (method, path) => {
    const app = createApp({
      authenticate,
      disconnectIntegration: async () => {
        throw new Error("must not be called");
      },
      startHubspotConnect: async () => {
        throw new Error("must not be called");
      },
      startCrmSyncRun: async () => {
        throw new Error("must not be called");
      },
    });

    const response = await app.request(path, { method, headers: authorized });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_INVALID" } });
  });

  it("routes unipile honestly: reserved, not connectable yet", async () => {
    const app = createApp({ authenticate });

    const connect = await app.request("/v1/integrations/unipile/connect", {
      method: "POST",
      headers: authorized,
    });
    expect(connect.status).toBe(501);
    expect(await connect.json()).toMatchObject({ error: { code: "PROVIDER_NOT_AVAILABLE" } });

    const status = await app.request("/v1/integrations/unipile", { headers: authorized });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ provider: "unipile", status: "not_connected" });

    const sync = await app.request("/v1/integrations/unipile/sync", { headers: authorized });
    expect(sync.status).toBe(501);
  });

  it("keeps the hubspot paths valid after provider generalization", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate,
      getHubspotConnection: async () => ({ provider: "hubspot", status: "not_connected" }),
      startCrmSyncRun: async () => ({
        state: "queued",
        run_ref: "33333333-3333-4333-8333-333333333333",
        requested_leads: 4,
        portal_id: "149239526",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        created: true,
      }),
      enqueueCrmSync: async (runId) => {
        enqueued.push(runId);
        return { id: "run_sync" };
      },
    });

    const status = await app.request("/v1/integrations/hubspot", { headers: authorized });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ provider: "hubspot", status: "not_connected" });

    const sync = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
      headers: authorized,
    });
    expect(sync.status).toBe(200);
    expect(enqueued).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("rejects unauthenticated management calls before business logic", async () => {
    const app = createApp({
      getConfig: async () => {
        throw new Error("must not be called");
      },
    });

    for (const [method, path] of [
      ["GET", "/v1/status"],
      ["GET", "/v1/config"],
      ["PATCH", "/v1/config"],
      ["DELETE", "/v1/integrations/hubspot"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(401);
    }
  });
});
