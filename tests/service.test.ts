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
});
