import { describe, expect, it } from "vitest";

import {
  createWorkspace,
  getCrmSyncStatus,
  getWorkspaceStatus,
  getOnboardingStatus,
  getRunStatus,
  startCrmSyncRun,
  startRun,
  submitOnboarding,
} from "../src/workspace-operations.js";

describe("workspace RPC operations", () => {
  it("reads status through the authenticated request-scoped client", async () => {
    const expected = {
      state: "ready_for_connections" as const,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      next_action: null,
    };
    const client = {
      rpc: async (name: string, args?: unknown) => {
        if (name !== "get_lifty_workspace_status" || args !== undefined) {
          return {
            data: null,
            error: { code: "WRONG_RPC", message: "wrong RPC contract" },
          };
        }
        return { data: expected, error: null };
      },
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).resolves.toEqual(expected);
  });

  it("creates the login workspace through the authenticated client", async () => {
    const expected = {
      state: "ready_for_connections" as const,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      created: true,
    };
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: expected, error: null };
      },
    };

    await expect(
      createWorkspace(
        { userId: "founder-123", client },
        { name: "Example", description: "Example helps founders." },
      ),
    ).resolves.toEqual(expected);
    expect(calls).toEqual([
      {
        name: "create_lifty_workspace",
        args: { name: "Example", description: "Example helps founders." },
      },
    ]);
  });

  it("normalizes a missing description to null before calling the RPC", async () => {
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return {
          data: {
            state: "ready_for_connections",
            workspace: { workspace_ref: "ws_opaque", name: "Example" },
            created: false,
          },
          error: null,
        };
      },
    };

    await expect(
      createWorkspace({ userId: "founder-123", client }, { name: "Example" }),
    ).resolves.toMatchObject({ created: false });
    expect(calls).toEqual([
      { name: "create_lifty_workspace", args: { name: "Example", description: null } },
    ]);
  });

  it.each([
    ["PT401", "unauthenticated", 401, "UNAUTHORIZED"],
    ["PT400", "lifty_workspace_invalid: name", 422, "WORKSPACE_INVALID"],
    ["PT413", "lifty_workspace_too_large: description", 413, "WORKSPACE_FIELD_TOO_LARGE"],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING"],
    ["PT409", "lifty_run_not_configured", 409, "RUN_NOT_CONFIGURED"],
    ["PT409", "lifty_run_already_completed", 409, "RUN_ALREADY_COMPLETED"],
    ["PT409", "lifty_run_workspace_suspended", 409, "WORKSPACE_SUSPENDED"],
    ["PT409", "lifty_run_unavailable", 409, "RUN_UNAVAILABLE"],
    ["PT409", "provisioning_conflict", 409, "PROVISIONING_CONFLICT"],
    ["XX000", "private internal failure", 502, "SUPABASE_REQUEST_FAILED"],
  ])(
    "maps create-workspace %s failures to a safe %s response",
    async (databaseCode, databaseMessage, status, publicCode) => {
      const client = {
        rpc: async () => ({
          data: null,
          error: { code: databaseCode, message: databaseMessage },
        }),
      };

      await expect(
        createWorkspace({ userId: "founder-123", client }, { name: "Example" }),
      ).rejects.toMatchObject({ status, code: publicCode });
    },
  );

  it("rejects a malformed create-workspace response at the control-plane boundary", async () => {
    const client = {
      rpc: async () => ({
        data: {
          state: "ready_for_connections",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          created: true,
          private_field: "do-not-forward",
        },
        error: null,
      }),
    };

    await expect(
      createWorkspace({ userId: "founder-123", client }, { name: "Example" }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });

  it("submits through the authenticated client without forwarding actor identity", async () => {
    const draft = { schema_version: "2.0", company: { name: "Example" } };
    const expected = {
      state: "submitted" as const,
      submission_ref: "11111111-1111-4111-8111-111111111111",
      draft_digest: `sha256:${"d".repeat(64)}`,
      import_status: "pending" as const,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      created: true,
    };
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: expected, error: null };
      },
    };

    await expect(
      submitOnboarding({ userId: "founder-123", client }, draft),
    ).resolves.toEqual(expected);
    expect(calls).toEqual([
      { name: "submit_lifty_onboarding", args: { draft } },
    ]);
  });

  it("rejects a submission response with unexpected fields", async () => {
    const client = {
      rpc: async () => ({
        data: {
          state: "submitted",
          submission_ref: "11111111-1111-4111-8111-111111111111",
          draft_digest: `sha256:${"d".repeat(64)}`,
          import_status: "pending",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          created: true,
          api_key: "secret-never-surface",
        },
        error: null,
      }),
    };

    await expect(
      submitOnboarding({ userId: "founder-123", client }, { draft: true }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });

  it("returns the onboarding status through the authenticated client", async () => {
    const expected = {
      state: "imported" as const,
      submission_ref: "11111111-1111-4111-8111-111111111111",
      draft_digest: `sha256:${"d".repeat(64)}`,
      submitted_at: "2026-09-01T21:00:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      summary: {
        icp: {
          version: 1,
          label: "Example lane",
          person_locations: ["United States"],
          organization_industries: ["computer software"],
          organization_num_employees_ranges: ["51,200"],
          person_seniorities: null,
          personas: [{ name: "Founder buyer", titles: ["Founder"] }],
        },
        prompt: { agent: "scout" as const, chars: 1234, published: true as const },
      },
    };
    const calls: string[] = [];
    const client = {
      rpc: async (name: string) => {
        calls.push(name);
        return { data: expected, error: null };
      },
    };

    await expect(
      getOnboardingStatus({ userId: "founder-123", client }),
    ).resolves.toEqual(expected);
    expect(calls).toEqual(["get_lifty_onboarding_status"]);
  });

  it("maps database errors to stable public API errors without exposing details", async () => {
    const client = {
      rpc: async () => ({
        data: null,
        error: {
          code: "PT409",
          message: "workspace_already_exists",
          details: "private database detail",
          hint: "private database hint",
        },
      }),
    };

    await expect(
      submitOnboarding({ userId: "founder-123", client }, { draft: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WORKSPACE_ALREADY_EXISTS",
      message: "This account already has a LIFTY workspace.",
    });
  });

  it.each([
    ["PT401", "unauthenticated", 401, "UNAUTHORIZED"],
    ["PT400", "lifty_draft_invalid: gate_4_hard_disqualifier", 422, "DRAFT_INVALID"],
    ["PT413", "lifty_draft_too_large: max_nodes", 413, "DRAFT_TOO_LARGE"],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING"],
    ["PT409", "lifty_run_not_configured", 409, "RUN_NOT_CONFIGURED"],
    ["PT409", "lifty_run_already_completed", 409, "RUN_ALREADY_COMPLETED"],
    ["PT409", "lifty_run_workspace_suspended", 409, "WORKSPACE_SUSPENDED"],
    ["PT409", "lifty_run_unavailable", 409, "RUN_UNAVAILABLE"],
    ["PT409", "provisioning_conflict", 409, "PROVISIONING_CONFLICT"],
    [
      "P0001",
      "Workspace 153b9a10 requires at least one active approach and exactly one active fallback",
      502,
      "PROVISIONING_REJECTED",
    ],
    ["XX000", "private internal failure", 502, "SUPABASE_REQUEST_FAILED"],
  ])(
    "maps %s failures to a safe %s response",
    async (databaseCode, databaseMessage, status, publicCode) => {
      const client = {
        rpc: async () => ({
          data: null,
          error: { code: databaseCode, message: databaseMessage },
        }),
      };

      await expect(
        submitOnboarding({ userId: "founder-123", client }, { draft: true }),
      ).rejects.toMatchObject({ status, code: publicCode });
    },
  );

  it("normalizes a PostgREST single-row array before validating the response", async () => {
    const expected = {
      state: "needs_workspace" as const,
      workspace: null,
      next_action: "provision_workspace" as const,
    };
    const client = {
      rpc: async () => ({ data: [expected], error: null }),
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).resolves.toEqual(expected);
  });

  it("rejects malformed database responses at the control-plane boundary", async () => {
    const client = {
      rpc: async () => ({
        data: { state: "ready_for_connections", private_field: "do-not-forward" },
        error: null,
      }),
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });
});

describe("first run operations", () => {
  it("starts the run through the authenticated client", async () => {
    const expected = {
      state: "queued" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      created: true,
    };
    const calls: string[] = [];
    const client = {
      rpc: async (name: string) => {
        calls.push(name);
        return { data: expected, error: null };
      },
    };

    await expect(startRun({ userId: "founder-123", client })).resolves.toEqual(expected);
    expect(calls).toEqual(["start_lifty_run"]);
  });

  it("maps a not-configured start to a push-first error", async () => {
    const client = {
      rpc: async () => ({
        data: null,
        error: { code: "PT409", message: "lifty_run_not_configured" },
      }),
    };

    await expect(startRun({ userId: "founder-123", client })).rejects.toMatchObject({
      status: 409,
      code: "RUN_NOT_CONFIGURED",
    });
  });

  it("returns the run status through the authenticated client", async () => {
    const expected = {
      state: "running" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      leads_discovered: 5,
      leads_researched: 2,
      error_code: null,
      started_at: "2026-09-01T21:00:00Z",
      completed_at: null,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      leads: null,
    };
    const calls: string[] = [];
    const client = {
      rpc: async (name: string) => {
        calls.push(name);
        return { data: expected, error: null };
      },
    };

    await expect(getRunStatus({ userId: "founder-123", client })).resolves.toEqual(expected);
    expect(calls).toEqual(["get_lifty_run_status"]);
  });
});

describe("crm sync RPC operations", () => {
  const startFixture = {
    state: "queued" as const,
    run_ref: "33333333-3333-4333-8333-333333333333",
    requested_leads: 4,
    portal_id: "149239526",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created: true,
  };

  it("starts the sync through the authenticated request-scoped client", async () => {
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: startFixture, error: null };
      },
    };

    await expect(
      startCrmSyncRun({ userId: "founder-123", client }),
    ).resolves.toEqual(startFixture);
    expect(calls).toEqual([{ name: "start_lifty_crm_sync_run", args: undefined }]);
  });

  it.each([
    ["PT401", "unauthenticated", 401, "UNAUTHORIZED"],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING"],
    ["PT409", "lifty_sync_not_connected", 409, "HUBSPOT_NOT_CONNECTED"],
    ["PT409", "lifty_sync_nothing_to_sync", 409, "NOTHING_TO_SYNC"],
    ["PT409", "lifty_sync_run_in_progress", 409, "RUN_IN_PROGRESS"],
    ["PT409", "lifty_sync_workspace_suspended", 409, "WORKSPACE_SUSPENDED"],
    ["XX000", "private internal failure", 502, "SUPABASE_REQUEST_FAILED"],
  ])(
    "maps sync-start %s %s failures to a safe response",
    async (databaseCode, databaseMessage, status, publicCode) => {
      const client = {
        rpc: async () => ({
          data: null,
          error: { code: databaseCode, message: databaseMessage },
        }),
      };

      await expect(
        startCrmSyncRun({ userId: "founder-123", client }),
      ).rejects.toMatchObject({ status, code: publicCode });
    },
  );

  it("reads sync status and rejects unexpected fields at the boundary", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "33333333-3333-4333-8333-333333333333",
      requested_leads: 4,
      leads_synced: 4,
      error_code: null,
      portal_id: "149239526",
      started_at: "2026-09-02T14:00:00Z",
      completed_at: "2026-09-02T14:05:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
    };
    const okClient = {
      rpc: async () => ({ data: status, error: null }),
    };
    await expect(
      getCrmSyncStatus({ userId: "founder-123", client: okClient }),
    ).resolves.toEqual(status);

    const leakyClient = {
      rpc: async () => ({
        data: { ...status, access_token: "never-forward" },
        error: null,
      }),
    };
    await expect(
      getCrmSyncStatus({ userId: "founder-123", client: leakyClient }),
    ).rejects.toMatchObject({ status: 502, code: "SUPABASE_INVALID_RESPONSE" });
  });
});
