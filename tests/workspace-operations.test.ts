import { describe, expect, it } from "vitest";

import {
  getWorkspaceStatus,
  provisionWorkspace,
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

  it("provisions through the authenticated client without forwarding actor identity", async () => {
    const draft = { schema_version: "1.0", company: { name: "Example" } };
    const expected = {
      state: "ready_for_connections" as const,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      draft_digest: "sha256:deadbeef",
    };
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: expected, error: null };
      },
    };

    await expect(
      provisionWorkspace({ userId: "founder-123", client }, draft),
    ).resolves.toEqual(expected);
    expect(calls).toEqual([
      { name: "provision_lifty_workspace", args: { draft } },
    ]);
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
      provisionWorkspace({ userId: "founder-123", client }, { draft: true }),
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
        provisionWorkspace({ userId: "founder-123", client }, { draft: true }),
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
