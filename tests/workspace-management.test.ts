import { describe, expect, it } from "vitest";

import { createCurrentClient as createApp } from "./current-client.js";

const session = { userId: "founder-123", client: { kind: "scoped" } };
const authenticate = async () => ({ ok: true as const, session });
const authorized = { authorization: "Bearer valid-token" };
describe("LIFTY API workspace management (P6)", () => {

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
});
