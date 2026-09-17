import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createCrmMappingReadinessCheck } from "../src/crm-mapping/readiness.js";
const config = { supabaseUrl: "https://db.test", publishableKey: "public", jwks: new URL("https://db.test/jwks") };
const serverKey = "dedicated-test-capability-key";

describe("general CRM capability readiness", () => {
  it("checks only the versioned capability with bounded network access", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ready: true, version: "lifty-crm-mapping.v1" }));
    expect(await createCrmMappingReadinessCheck(config, { serverKey, fetch: fetcher })()).toBe(true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://db.test/rest/v1/rpc/lifty_crm_mapping_tools", {
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { apikey: "public", "content-type": "application/json" },
      body: JSON.stringify({ p_server_key: serverKey, p_operation: "capabilities", p_payload: {} }),
    });
  });

  it.each([
    () => Response.json({ ready: true, version: "lifty-crm-company.v1" }),
    () => Response.json({ ready: false, version: "lifty-crm-mapping.v1" }),
    () => Response.json({ ready: true, version: "lifty-crm-mapping.v1" }, { status: 403 }),
    () => new Response("not json"),
    () => { throw new Error("unavailable"); },
  ])("fails closed when the installed capability cannot be verified", async response => {
    expect(await createCrmMappingReadinessCheck(config, { serverKey, fetch: async () => response() })()).toBe(false);
  });

  it("does not call the database when unconfigured", async () => {
    expect(await createCrmMappingReadinessCheck(config, null)()).toBe(false);
  });

  it("publishes capability-only health without authentication or tenant reads", async () => {
    const tenantRead = vi.fn(async () => { throw new Error("tenant access forbidden"); });
    const app = createApp({ authenticate: tenantRead, getWorkspace: tenantRead, checkCrmMappingReadiness: async () => true });
    const response = await app.request("/readyz/crm-mapping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", capability: "lifty-crm-mapping.v1" });
    expect(tenantRead).not.toHaveBeenCalled();
    expect((await createApp().request("/readyz/crm-mapping")).status).toBe(503);
    const throws = createApp({ checkCrmMappingReadiness: async () => { throw new Error("private fixture"); } });
    const failed = await throws.request("/readyz/crm-mapping");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ status: "not_ready", capability: "lifty-crm-mapping.v1" });
  });
});
