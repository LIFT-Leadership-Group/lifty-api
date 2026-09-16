import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("public agent task context", () => {
  it("gates every task's changed workflow behind the calibration client contract", async () => {
    const app = createApp();
    for (const task of ["onboarding", "workspace", "campaign"]) {
      for (const version of ["v1", "v2", "v3"]) {
        const legacy = await (await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.${version}`)).json();
        expect(legacy.instructions).toContain("Upgrade the installed LIFTY CLI");
        expect(legacy.schemas).toEqual({}); expect(legacy.references).toEqual({});
      }
      const response = await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v4`);
      expect(response.status).toBe(200);
      const current = await response.json();
      expect(Object.keys(current.schemas).length).toBeGreaterThan(0);
      expect(current.references.calibration).toBeDefined();
      expect(current.instructions).toContain("<installed-runner>");
      expect(current.instructions).toContain("project or global");
      expect(current.instructions).not.toContain("<active-project>/.lifty/bin/lifty.mjs");
      if (task !== "campaign") expect(current.instructions).toContain("crm companies context");
    }
  });
  it("serves onboarding guidance before login without reading a workspace", async () => {
    const app = createApp({
      authenticate: async () => { throw new Error("public context must not authenticate"); },
      getOnboardingContext: async () => { throw new Error("public context must not read tenant context"); },
    });
    const response = await app.request("/v1/context/onboarding?client_contract=lifty-cli-context.v4");
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
    expect((await (await app.request("/v1/context/onboarding")).json()).schemas).toEqual({});
  });

  it("keeps task guidance separate and exposes the input contracts for each task", async () => {
    const app = createApp();
    const workspaceResponse = await app.request("/v1/context/workspace?client_contract=lifty-cli-context.v4");
    const campaignResponse = await app.request("/v1/context/campaign?client_contract=lifty-cli-context.v4");
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
