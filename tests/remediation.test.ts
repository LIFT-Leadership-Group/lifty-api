import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { PublicError } from "../src/errors.js";

const session = { userId: "founder", client: {} };
const authenticate = async () => ({ ok: true as const, session });

describe("platform remediation", () => {
  it("keeps status available for externally managed ICP lanes", async () => {
    const app = createApp({
      authenticate,
      getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: "ws", name: "Example" }, next_action: null }),
      getOnboardingStatus: async () => ({ state: "none" }),
      getRunStatus: async () => ({ state: "none" }),
      getCrmSyncStatus: async () => ({ state: "none" }),
      getHubspotConnection: async () => ({ provider: "hubspot", status: "not_connected" }),
      getConfigUpdateStatus: async () => ({ state: "none" }),
      getConfig: async () => { throw new PublicError({ status: 409, code: "MULTI_LANE_CONFIG_UNSUPPORTED", message: "external" }); },
    });
    const response = await app.request("/v1/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configuration: { icp_version: null, managed_externally: true } });
  });

  it("disconnects Slack without enqueuing a HubSpot revocation", async () => {
    const enqueue = vi.fn();
    const disconnect = vi.fn(async () => ({ provider: "slack" as const, status: "disconnected" as const, portal_id: null, disconnected_at: "2026-09-14T12:00:00Z", workspace: { workspace_ref: "ws", name: "Example" } }));
    const response = await createApp({ authenticate, disconnectIntegration: disconnect, enqueueIntegrationRevocation: enqueue }).request("/v1/integrations/slack", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(session, "slack");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("shares a per-user mutation budget, isolates other users, and resets after a minute", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const app = createApp({ authenticate: async (request) => ({ ok: true, session: { ...session, userId: request.headers.get("x-test-user") ?? "founder" } }), log: () => {} });
      const paths = ["/v1/workspace", "/v1/onboarding", "/v1/workspace/runs"];
      for (let index = 0; index < 10; index++) {
        const response = await app.request(paths[index % 3]!, { method: "POST" });
        expect(response.status).not.toBe(429);
      }
      for (const path of paths) {
        const denied = await app.request(path, { method: "POST" });
        expect(denied.status).toBe(429);
        expect(denied.headers.get("Retry-After")).toBe("60");
      }
      expect((await app.request(paths[0]!, { method: "POST", headers: { "x-test-user": "second" } })).status).not.toBe(429);
      expect((await app.request("/v1/workspace")).status).not.toBe(429);
      now.mockReturnValue(160_000);
      expect((await app.request(paths[0]!, { method: "POST" })).status).not.toBe(429);
    } finally { now.mockRestore(); }
  });
});
