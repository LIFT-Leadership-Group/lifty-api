import { describe, expect, it } from "vitest";

import { createProductionApp } from "../src/service.js";

describe("production service composition", () => {
  it("wires the Supabase authenticator into the REST app", async () => {
    const app = createProductionApp({
      supabaseUrl: "https://project.supabase.test",
      publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] },
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer malformed.jwt.token" },
    });

    expect(response.status).toBe(401);
  });

  it("constructs a fetch-compatible app from deployment environment values", async () => {
    const serviceModule = await import("../src/service.js");
    const createDeploymentApp = (
      serviceModule as Record<string, unknown>
    ).createDeploymentApp;

    expect(createDeploymentApp).toBeTypeOf("function");

    const app = (createDeploymentApp as (
      environment: Record<string, string | undefined>,
    ) => ReturnType<typeof createProductionApp>)({
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      SUPABASE_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
