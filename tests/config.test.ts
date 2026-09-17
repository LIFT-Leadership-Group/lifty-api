import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnvironment = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_JWKS_URL:
    "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client-123",
  HUBSPOT_CLIENT_SECRET: "client-secret",
  SLACK_CLIENT_ID: "slack-client-123",
  SLACK_CLIENT_SECRET: "slack-client-secret",
  PUBLIC_BASE_URL: "https://lifty-api-staging-ox2h9.ondigitalocean.app",
  TRIGGER_SECRET_KEY: "tr_prod_test_key",
};

describe("service configuration", () => {
  it("defaults to the verified dashboard and accepts another HTTPS origin", () => {
    expect(loadConfig(validEnvironment).dashboardOrigin).toBe("https://lift-gtm-dashboard.vercel.app");
    expect(loadConfig({...validEnvironment,LIFTY_DASHBOARD_ORIGIN:"https://dashboard.example.com"}).dashboardOrigin).toBe("https://dashboard.example.com");
  });
  it.each(["http://dashboard.example.com","https://user:pass@example.com","https://example.com/path","https://example.com?q=x","https://example.com#x","https://example.com:444"])("rejects unsafe dashboard origin %s", origin => {
    expect(() => loadConfig({...validEnvironment,LIFTY_DASHBOARD_ORIGIN:origin})).toThrow(/LIFTY_DASHBOARD_ORIGIN/);
  });
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
    expect(config.slack).toEqual({
      clientId: "slack-client-123",
      clientSecret: "slack-client-secret",
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
    {
      ...validEnvironment,
      SLACK_CLIENT_ID: undefined,
      SLACK_CLIENT_SECRET: undefined,
    },
    { ...validEnvironment, SLACK_CLIENT_ID: undefined },
    { ...validEnvironment, SLACK_CLIENT_SECRET: undefined },
  ])("disables Slack OAuth until both credentials are configured", (environment) => {
    expect(loadConfig(environment).slack).toBeNull();
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

it("CRM capability is optional but must be bounded and dedicated", () => {
  expect(loadConfig(validEnvironment).crm).toBeNull();
  const key = "x".repeat(48);
  expect(loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:key}).crm).toEqual({serverKey:key,readOnly:false});
  for (const value of ["short","x".repeat(257)]) expect(()=>loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:value})).toThrow(/LIFTY_CRM_SERVER_KEY/);
  expect(()=>loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:key,TRIGGER_SECRET_KEY:key})).toThrow(/distinct/);
});

it.each(["DASHBOARD_READ_ONLY_MODE","CONSUMER_READ_ONLY_MODE"])("preserves company maintenance write freeze from %s", name => {
  for(const value of ["1","true","TRUE"]) expect(loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:"x".repeat(48),[name]:value}).crm?.readOnly).toBe(true);
});

describe("staged V2 configuration",()=>{
  const baseline={...validEnvironment,UNIPILE_DSN:"https://api1.unipile.com:13111",UNIPILE_ACCESS_TOKEN:"v1-test",
    LIFTY_EMAIL_SERVER_KEY:"e".repeat(40),LIFTY_LINKEDIN_SERVER_KEY:"l".repeat(40)};
  it("does not change existing V1 credentials when V2 is configured",()=>{
    const config=loadConfig({...baseline,UNIPILE_V2_ACCESS_TOKEN:"v2-test",UNIPILE_V2_APPLICATION_ID:"app_test",
      UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://connect-v2.lifty.test,https://previous-v2.lifty.test"});
    expect(config.email).toMatchObject({dsn:baseline.UNIPILE_DSN,accessToken:"v1-test",v2:{accessToken:"v2-test",applicationId:"app_test"}});
    expect(config.linkedin?.v2).toEqual(config.email?.v2);
    expect(config.unipileV2HostedAuthOrigins).toEqual(["https://auth.unipile.com","https://connect-v2.lifty.test","https://previous-v2.lifty.test"]);
  });
  it.each([
    {UNIPILE_V2_ACCESS_TOKEN:"token"},{UNIPILE_V2_APPLICATION_ID:"app_test"},
    {UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://connect-v2.lifty.test"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"not-app"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://account.unipile.com"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://user:pass@other.test"},
  ])("rejects incomplete or unsafe V2 config %j",extra=>{expect(()=>loadConfig({...baseline,...extra})).toThrow();});
});
