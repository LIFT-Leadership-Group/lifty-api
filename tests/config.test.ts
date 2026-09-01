import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnvironment = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_JWKS_URL:
    "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client-123",
  HUBSPOT_CLIENT_SECRET: "client-secret",
  PUBLIC_BASE_URL: "https://lifty-api-staging-ox2h9.ondigitalocean.app",
  TRIGGER_SECRET_KEY: "tr_prod_test_key",
};

describe("service configuration", () => {
  it("loads a publishable-key-only Supabase configuration", () => {
    const config = loadConfig(validEnvironment);

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      supabase: {
        supabaseUrl: "https://project.supabase.co",
        publishableKey: "sb_publishable_example",
      },
    });
    expect(config.supabase.jwks).toEqual(
      new URL(validEnvironment.SUPABASE_JWKS_URL),
    );
    expect(config.trigger).toEqual({
      apiUrl: "https://api.trigger.dev",
      secretKey: "tr_prod_test_key",
    });
    expect(config.hubspot).toEqual({
      clientId: "client-123",
      clientSecret: "client-secret",
      publicBaseUrl: "https://lifty-api-staging-ox2h9.ondigitalocean.app",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_example",
    });
  });

  it.each([
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("refuses to boot when %s is present", (secretName) => {
    expect(() =>
      loadConfig({ ...validEnvironment, [secretName]: "must-not-be-loaded" }),
    ).toThrow(/secret Supabase credentials are forbidden/i);
  });

  it("accepts inline JWKS without requiring network access", () => {
    const config = loadConfig({
      ...validEnvironment,
      SUPABASE_JWKS_URL: undefined,
      SUPABASE_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
      PORT: "8787",
      HOST: "127.0.0.1",
    });

    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.supabase.jwks).toEqual({
      keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
    });
  });

  it.each([
    [{ ...validEnvironment, SUPABASE_URL: undefined }, /SUPABASE_URL/],
    [
      { ...validEnvironment, SUPABASE_JWKS_URL: "http://attacker.example/jwks" },
      /SUPABASE_JWKS_URL/,
    ],
    [{ ...validEnvironment, PORT: "70000" }, /PORT/],
    [{ ...validEnvironment, HUBSPOT_CLIENT_ID: undefined }, /HUBSPOT_CLIENT_ID/],
    [{ ...validEnvironment, HUBSPOT_CLIENT_SECRET: undefined }, /HUBSPOT_CLIENT_SECRET/],
    [{ ...validEnvironment, TRIGGER_SECRET_KEY: undefined }, /TRIGGER_SECRET_KEY/],
    [
      { ...validEnvironment, TRIGGER_API_URL: "http://attacker.example" },
      /TRIGGER_API_URL/,
    ],
    [{ ...validEnvironment, PUBLIC_BASE_URL: undefined }, /PUBLIC_BASE_URL/],
    [
      { ...validEnvironment, PUBLIC_BASE_URL: "http://api.example.test" },
      /PUBLIC_BASE_URL/,
    ],
  ])("fails closed for an invalid environment", (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message);
  });
});
