import { describe, expect, it } from "vitest";

import {
  disconnectIntegration,
  getConfig,
  getConfigUpdateStatus,
  submitConfigUpdate,
} from "../src/workspace-operations.js";

const session = { userId: "founder-123", client: {} };

function recordingClient(result: unknown) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client = {
    rpc: async (name: string, args?: unknown) => {
      calls.push({ name, args });
      return { data: result, error: null };
    },
  };
  return { client, calls };
}

function failingClient(code: string, message: string) {
  return {
    rpc: async () => ({
      data: null,
      error: { code, message, details: "private detail", hint: "private hint" },
    }),
  };
}

const configFixture = {
  workspace_ref: "ws_opaque",
  config: {
    prompt: {
      version: "2026-09-02T20:00:00.000000Z",
      digest: `sha256:${"c".repeat(64)}`,
      source: "lif667_config_update",
      text: "## ICP gate",
    },
  },
};

describe("config read operations", () => {
  it("reads every section when no section is given", async () => {
    const { client, calls } = recordingClient(configFixture);
    await expect(getConfig({ ...session, client }, null)).resolves.toEqual(configFixture);
    expect(calls).toEqual([{ name: "get_lifty_config", args: undefined }]);
  });

  it("passes the section filter through", async () => {
    const { client, calls } = recordingClient(configFixture);
    await getConfig({ ...session, client }, "prompt");
    expect(calls).toEqual([{ name: "get_lifty_config", args: { section: "prompt" } }]);
  });

  it("rejects a config response with unexpected top-level fields", async () => {
    const { client } = recordingClient({ ...configFixture, api_key: "never" });
    await expect(getConfig({ ...session, client }, null)).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });
});

describe("config update operations", () => {
  const submission = {
    state: "queued",
    submission_ref: "44444444-4444-4444-8444-444444444444",
    run_ref: "44444444-4444-4444-8444-444444444444",
    request_digest: `sha256:${"e".repeat(64)}`,
    section_digests: { icp: `sha256:${"f".repeat(64)}` },
    import_status: "pending",
    changed_sections: ["tone"],
    artifact_actions: { icp: "none", tone: "applied", prompt: "regenerate", workspace: "none" },
    regenerate_icp: false,
    regenerate_prompt: true,
    workspace_ref: "ws_opaque",
    created: true,
  };

  it("submits the payload through the authenticated client", async () => {
    const { client, calls } = recordingClient(submission);
    const payload = { section: "tone" as const, values: { identity: "Clear" } };
    await expect(submitConfigUpdate({ ...session, client }, payload)).resolves.toMatchObject({
      state: "queued",
      submission_ref: submission.submission_ref,
    });
    expect(calls).toEqual([{ name: "submit_lifty_config_update", args: { payload } }]);
  });

  it("accepts a landed receipt on digest replay (completion fields present)", async () => {
    const { client } = recordingClient({
      ...submission,
      state: "applied",
      run_ref: null,
      import_status: "imported",
      created: false,
      icp_version: 3,
      icp_config_ref: "55555555-5555-4555-8555-555555555555",
      prompt_chars: 4321,
      prompt_version: "2026-09-02T21:00:00.000000Z",
      completed_at: "2026-09-02T21:00:00Z",
      error_code: null,
    });
    await expect(
      submitConfigUpdate({ ...session, client }, { values: { tone: { identity: "Clear" } } }),
    ).resolves.toMatchObject({ state: "applied", icp_version: 3, prompt_chars: 4321 });
  });

  it("reads the latest update status or one by reference", async () => {
    const { client, calls } = recordingClient({ state: "none" });
    await expect(getConfigUpdateStatus({ ...session, client }, null)).resolves.toEqual({
      state: "none",
    });
    await getConfigUpdateStatus({ ...session, client }, "44444444-4444-4444-8444-444444444444");
    expect(calls).toEqual([
      { name: "get_lifty_config_update_status", args: undefined },
      {
        name: "get_lifty_config_update_status",
        args: { p_submission_ref: "44444444-4444-4444-8444-444444444444" },
      },
    ]);
  });

  it.each([
    ["PT400", "lifty_config_invalid: icp_unknown_key", 422, "CONFIG_INVALID", "(icp_unknown_key)"],
    ["PT400", "lifty_config_invalid: prompt_instruction", 422, "CONFIG_INVALID", "(prompt_instruction)"],
    ["PT413", "lifty_config_too_large: max_nodes", 413, "CONFIG_TOO_LARGE", null],
    ["PT409", "lifty_config_missing_icp", 409, "CONFIG_NOT_READY", null],
    ["PT409", "lifty_prompt_hand_tuned", 409, "PROMPT_HAND_TUNED", null],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING", null],
    ["PT404", "lifty_config_update_missing", 404, "CONFIG_UPDATE_NOT_FOUND", null],
    ["PT401", "unauthenticated", 401, "UNAUTHORIZED", null],
    ["XX000", "private internal failure", 502, "SUPABASE_REQUEST_FAILED", null],
  ])(
    "maps %s %s to a safe %s %s response",
    async (databaseCode, databaseMessage, status, publicCode, fragment) => {
      const client = failingClient(databaseCode, databaseMessage);
      const rejection = expect(
        submitConfigUpdate({ ...session, client }, { section: "icp", values: { x: 1 } }),
      ).rejects;
      await rejection.toMatchObject({ status, code: publicCode });
      if (fragment) {
        await rejection.toMatchObject({ message: expect.stringContaining(fragment) });
      }
      await rejection.not.toMatchObject({ message: expect.stringContaining("private") });
    },
  );
});

describe("disconnect operations", () => {
  const disconnected = {
    provider: "hubspot",
    status: "disconnected",
    portal_id: "149239526",
    disconnected_at: "2026-09-02T21:00:00Z",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
  };

  it("disconnects through the authenticated client", async () => {
    const { client, calls } = recordingClient(disconnected);
    await expect(disconnectIntegration({ ...session, client }, "hubspot")).resolves.toEqual(
      disconnected,
    );
    expect(calls).toEqual([
      { name: "disconnect_lifty_integration", args: { p_provider: "hubspot" } },
    ]);
  });

  it("rejects a disconnect response that carries anything beyond the contract", async () => {
    const { client } = recordingClient({ ...disconnected, refresh_token: "never" });
    await expect(disconnectIntegration({ ...session, client }, "hubspot")).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });

  it.each([
    ["PT409", "lifty_integration_not_connected", 409, "NOT_CONNECTED"],
    ["PT409", "lifty_sync_in_flight", 409, "SYNC_IN_PROGRESS"],
    ["PT400", "lifty_provider_invalid", 400, "PROVIDER_INVALID"],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING"],
  ])(
    "maps disconnect %s %s failures to a safe response",
    async (databaseCode, databaseMessage, status, publicCode) => {
      const client = failingClient(databaseCode, databaseMessage);
      await expect(
        disconnectIntegration({ ...session, client }, "hubspot"),
      ).rejects.toMatchObject({ status, code: publicCode });
    },
  );
});
