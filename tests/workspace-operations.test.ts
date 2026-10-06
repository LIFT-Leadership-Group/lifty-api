import { enqueueNotificationTest, getCrmSyncStatus, getNotificationConfig, getRunStatus, getWorkspaceStatus, listSlackNotificationChannels, setNotificationRoute, startCrmSyncRun, startRun, upsertNotificationDestination } from "../src/workspace-operations.js";
import { describe, expect, it } from "vitest";

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

describe("notification configuration operations", () => {
  const destinationRef = "64300000-0000-4000-a000-000000000010";
  const config = {
    workspace_ref: "64300000-0000-4000-a000-000000000001",
    notification_types: [
      "reply.requires_action" as const,
      "meeting.booked" as const,
      "sending_account.needs_reconnect" as const,
      "system.test" as const,
    ],
    slack: {
      status: "connected" as const,
      team_id: "T643TEAM",
      team_name: "Example Robotics",
      reconnect_required: false,
    },
    destinations: [{
      destination_ref: destinationRef,
      provider: "slack" as const,
      external_id: "C643CHANNEL",
      display_name: "client-alerts",
      status: "active" as const,
    }],
    routes: [{
      route_ref: "64300000-0000-4000-a000-000000000011",
      notification_type: "reply.requires_action" as const,
      destination_ref: destinationRef,
      enabled: true,
    }],
  };

  it("uses the authenticated request client for reads without forwarding identity", async () => {
    const calls: Array<{ kind: string; name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ kind: "rpc", name, args });
        return { data: config, error: null };
      },
      functions: {
        invoke: async (name: string, args?: unknown) => {
          calls.push({ kind: "function", name, args });
          return {
            data: { channels: [{ id: "C643CHANNEL", name: "client-alerts", is_private: false }] },
            error: null,
          };
        },
      },
    };
    const session = { userId: "founder-123", client };

    await expect(getNotificationConfig(session)).resolves.toEqual(config);
    await expect(listSlackNotificationChannels(session)).resolves.toEqual({
      channels: [{ id: "C643CHANNEL", name: "client-alerts", is_private: false }],
    });
    expect(calls).toEqual([
      { kind: "rpc", name: "get_lifty_notification_config", args: undefined },
      { kind: "function", name: "lifty-slack-channels", args: { method: "POST" } },
    ]);
  });

  it("reports a missing Slack grant as a setup step, not a transient failure", async () => {
    const failing = (status: number, body: unknown) => ({ functions: { invoke: async () => ({ data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: new Response(JSON.stringify(body), { status }) }) }) } });
    const read = (status: number, body: unknown) => listSlackNotificationChannels({ userId: "founder-123", client: failing(status, body) });
    await expect(read(409, { error: "slack_not_connected" })).rejects.toMatchObject({ status: 409, code: "SLACK_NOT_CONNECTED" });
    await expect(read(409, { error: "slack_reconnect_required" })).rejects.toMatchObject({ status: 409, code: "SLACK_RECONNECT_REQUIRED" });
    await expect(read(500, { error: "channel_list_unavailable" })).rejects.toMatchObject({ status: 502, code: "SLACK_CHANNELS_UNAVAILABLE" });
    // A Response-like object from another fetch implementation, with an unreadable body.
    const foreign = { functions: { invoke: async () => ({ data: null, error: Object.assign(new Error("non-2xx"), { context: { status: 409, json: async () => { throw new Error("consumed"); } } }) }) } };
    await expect(listSlackNotificationChannels({ userId: "founder-123", client: foreign })).rejects.toMatchObject({ status: 409, code: "SLACK_NOT_CONNECTED" });
  });

  it("maps every write to the audited notification RPC contract", async () => {
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        if (name === "upsert_lifty_notification_destination") {
          return { data: config.destinations[0], error: null };
        }
        if (name === "set_lifty_notification_route") {
          return { data: config.routes[0], error: null };
        }
        return {
          data: {
            delivery_ref: "64300000-0000-4000-a000-000000000012",
            destination_ref: destinationRef,
            status: "queued",
          },
          error: null,
        };
      },
    };
    const session = { userId: "founder-123", client };

    await upsertNotificationDestination(session, {
      channel_id: "C643CHANNEL",
      channel_name: "client-alerts",
    });
    await setNotificationRoute(session, {
      notification_type: "reply.requires_action",
      destination_ref: destinationRef,
      enabled: true,
    });
    await enqueueNotificationTest(session, destinationRef);

    expect(calls).toEqual([
      {
        name: "upsert_lifty_notification_destination",
        args: { p_external_id: "C643CHANNEL", p_display_name: "client-alerts" },
      },
      {
        name: "set_lifty_notification_route",
        args: {
          p_notification_type: "reply.requires_action",
          p_destination_id: destinationRef,
          p_enabled: true,
        },
      },
      {
        name: "enqueue_lifty_notification_test",
        args: { p_destination_id: destinationRef },
      },
    ]);
  });

  it("rejects a malformed or secret-bearing response at the boundary", async () => {
    const client = {
      rpc: async () => ({ data: { ...config, bot_token: "xoxb-never-forward" }, error: null }),
    };

    await expect(
      getNotificationConfig({ userId: "founder-123", client }),
    ).rejects.toMatchObject({ status: 502, code: "SUPABASE_INVALID_RESPONSE" });
  });

  it("maps channel lookup failures to a stable secret-free error", async () => {
    const client = {
      functions: {
        invoke: async () => ({ data: null, error: { message: "xoxb-private-upstream-body" } }),
      },
    };

    await expect(
      listSlackNotificationChannels({ userId: "founder-123", client }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SLACK_CHANNELS_UNAVAILABLE",
      message: "LIFTY could not load Slack channels. Try again in a moment.",
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
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: expected, error: null };
      },
    };

    await expect(startRun({ userId: "founder-123", client })).resolves.toEqual(expected);
    expect(calls).toEqual([{ name: "start_lifty_run", args: { p_workspace_id: null } }]);
  });

  it.each([
    [{ code: "PT409", message: "RUN_NOT_CONFIGURED" }, { status: 409, code: "RUN_NOT_CONFIGURED" }],
    [{ code: "PT409", message: "RUN_IN_PROGRESS" }, { status: 409, code: "RUN_IN_PROGRESS" }],
    [{ code: "PT409", message: "RESEARCH_LIMIT_REACHED", details: JSON.stringify({ resets_at: "2026-10-05T00:00:00+00:00", internal: "x" }) },
      { status: 409, code: "RESEARCH_LIMIT_REACHED", resets_at: "2026-10-05T00:00:00+00:00" }],
    [{ code: "PT409", message: "lifty_apollo_allowance_exhausted", details: "{\"provider\":\"secret\"}" }, { status: 502, code: "SAMPLE_REVIEW_UNAVAILABLE", resets_at: undefined }],
  ])("maps typed start errors to public codes without internal causes: %j", async (error, expected) => {
    const client = { rpc: async () => ({ data: null, error }) };
    const failure = await startRun({ userId: "founder-123", client }).catch(caught => caught);
    expect(failure).toMatchObject(expected);
    expect(JSON.stringify({ code: failure.code, message: failure.message, resets_at: failure.resets_at })).not.toMatch(/apollo|allowance|secret|internal/i);
  });

  it("builds research links only for verified lead IDs with available workspace research", async () => {
    const lead = {name:"Test",title:null,company:null,linkedin_url:"https://www.linkedin.com/in/test",tier:null,fit_rationale:null,stage:null};
    const id="33333333-3333-4333-8333-333333333333";
    const data={state:"succeeded",run_ref:"run",requested_leads:3,leads_discovered:3,leads_researched:1,error_code:null,started_at:"2026-09-14T00:00:00Z",completed_at:null,reviewed_at:null,workspace:{workspace_ref:"ws",name:"Test"},leads:[{...lead,lead_ref:id,research_available:true},{...lead,lead_ref:id,research_available:false,research_url:"https://wrong.example"},{...lead}]};
    const calls:string[]=[];
    const result=await getRunStatus({userId:"founder",client:{rpc:async(name:string)=>{calls.push(name);return {data,error:null};}}},"https://dashboard.example.com");
    expect(result.state).toBe("succeeded");
    if(result.state!=="none") expect(result.leads?.map(lead=>lead.research_url)).toEqual([`https://dashboard.example.com/protected/leads/${id}`,null,null]);
    expect(calls).toEqual(["get_lifty_run_status"]);
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
      reviewed_at: null,
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
