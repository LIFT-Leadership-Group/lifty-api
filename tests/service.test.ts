import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionApp } from "../src/service.js";

describe("production service composition", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("exposes the configured app through Vercel method handlers", async () => {
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv(
      "SUPABASE_PUBLISHABLE_KEY",
      "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
    );
    vi.stubEnv(
      "SUPABASE_JWKS",
      JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
    );

    const adapter = await import("../api/index.js");

    expect(adapter.GET).toBeTypeOf("function");
    expect(adapter.POST).toBe(adapter.GET);
    expect(adapter.DELETE).toBe(adapter.GET);

    const response = await adapter.GET(
      new Request("https://lifty-api-staging.example/healthz"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
