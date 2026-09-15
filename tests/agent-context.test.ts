import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("public agent task context", () => {
  it("serves company setup only to clients with the company command contract", async () => {
    const app = createApp();
    for (const task of ["onboarding", "workspace"]) {
      const legacy = await (await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v1`)).json();
      const response = await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v2`);
      expect(response.status).toBe(200);
      const current = await response.json();
      expect(legacy.instructions).not.toContain("crm companies context");
      expect(current.instructions).toContain("required before HubSpot sync");
      expect(current.instructions).toContain("crm companies context");
      expect(current.instructions).toContain("crm companies apply --input -");
      expect(current.revision).not.toBe(legacy.revision);
      expect(current.schemas).toEqual(legacy.schemas);
    }
  });
  it("serves onboarding guidance before login without reading a workspace", async () => {
    const app = createApp({
      authenticate: async () => { throw new Error("public context must not authenticate"); },
      getOnboardingContext: async () => { throw new Error("public context must not read tenant context"); },
    });
    const response = await app.request("/v1/context/onboarding?client_contract=lifty-cli-context.v1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      format: "lifty-context.v1", task: "onboarding",
      schemas: { draft: { properties: { schema_version: { const: "2.1" } } } },
    });
    expect(body.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.instructions.length).toBeGreaterThan(100);
    expect(body.references.interview.length).toBeGreaterThan(100);
    expect(body.workspace).toBeUndefined();
    expect(body.scout_global_base).toBeUndefined();
    expect(await (await app.request("/v1/context/onboarding")).json()).toEqual(body);
  });

  it("keeps task guidance separate and exposes the input contracts for each task", async () => {
    const app = createApp();
    const workspaceResponse = await app.request("/v1/context/workspace");
    const campaignResponse = await app.request("/v1/context/campaign");
    expect(workspaceResponse.status).toBe(200);
    expect(campaignResponse.status).toBe(200);
    const workspace = await workspaceResponse.json();
    const campaign = await campaignResponse.json();
    expect(workspace.schemas.config_update).toBeDefined();
    expect(workspace.schemas.draft).toBeUndefined();
    expect(campaign.schemas.email_campaign).toBeDefined();
    expect(campaign.schemas.linkedin_campaign).toBeDefined();
    expect(campaign.schemas.draft).toBeUndefined();
    expect(campaign.revision).not.toBe(workspace.revision);
  });

  it("refuses unavailable tasks and unsupported clients without returning guessed guidance", async () => {
    const app = createApp();
    const unknown = await app.request("/v1/context/unknown");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("CONTEXT_NOT_FOUND");
    const unsupported = await app.request("/v1/context/onboarding?client_contract=unknown");
    expect(unsupported.status).toBe(409);
    expect((await unsupported.json()).error.code).toBe("CONTEXT_CLIENT_UNSUPPORTED");
    // Public documentation must not open neighboring private routes.
    expect((await app.request("/v1/onboarding/context")).status).toBe(401);
    expect((await app.request("/v1/context/onboarding", { method: "POST" })).status).toBe(401);
  });

  it("documents task context as public without removing security from private generation context", async () => {
    const document = await (await createApp().request("/openapi.json")).json();
    expect(document.paths["/v1/context/{task}"].get.security).toEqual([]);
    expect(document.paths["/v1/onboarding/context"].get.security).toEqual([{ bearerAuth: [] }]);
  });
});
