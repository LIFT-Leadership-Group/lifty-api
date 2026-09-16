import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const current = "lifty-cli-context.v5";
const retired = ["lifty-cli-context.v1", "lifty-cli-context.v2", "lifty-cli-context.v3", "lifty-cli-context.v4"];
const tasks = ["onboarding", "workspace", "campaign", "stages", "business", "targeting", "research-criteria",
  "sample-review", "commercial-voice", "crm", "sending-accounts", "campaigns", "notifications", "capacity"];

describe("retired client contracts", () => {
  it.each(retired)("rejects %s on every public context without exposing executable guidance", async version => {
    const app = createApp();
    for (const task of tasks) {
      const response = await app.request(`/v1/context/${task}?client_contract=${version}`);
      expect(response.status, task).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("CONTEXT_CLIENT_UNSUPPORTED");
      expect(body.error.message).toContain(current);
      expect(body.instructions).toBeUndefined();
      expect(body.operations).toBeUndefined();
    }
  });

  it.each([undefined, ...retired, "unknown", "lifty-cli-context.v6"])("rejects private requests from %s before any business handler", async version => {
    const business = vi.fn(async () => { throw new Error("retired client reached business state"); });
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: business, getConfig: business, startRun: business, submitOnboarding: business,
      startHubspotConnect: business, startSlackConnect: business, startEmailConnect: business,
      startLinkedinConnect: business, log: () => {} });
    const contract = await (await app.request("/openapi.json")).json();
    let checked = 0;
    for (const [path, methods] of Object.entries(contract.paths) as Array<[string, Record<string, any>]>) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.security?.some((entry: Record<string, unknown>) => "bearerAuth" in entry)) continue;
        const response = await app.request(path.replace(/\{[^}]+\}/g, "11111111-1111-4111-8111-111111111111"), {
          method: method.toUpperCase(),
          headers: { ...(version ? { "x-lifty-client-contract": version } : {}), "content-type": "application/json" },
          ...(["get", "head"].includes(method) ? {} : { body: "{}" }),
        });
        expect(response.status, `${method} ${path}`).toBe(409);
        expect((await response.json()).error.code).toBe("CONTEXT_CLIENT_UNSUPPORTED");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(business).not.toHaveBeenCalled();
  });

  it("keeps v5 context and authenticated stage reads usable", async () => {
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "needs_workspace", workspace: null, next_action: "provision_workspace" }) });
    for (const task of tasks) {
      const response = await app.request(`/v1/context/${task}?client_contract=${current}`);
      expect(response.status).toBe(200);
      expect((await response.json()).instructions.length).toBeGreaterThan(0);
    }
    const response = await app.request("/v1/workspace/business", { headers: { "x-lifty-client-contract": current } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { state: "needs_workspace" }, configuration: null });
  });

  it("documents the required current client header on every authenticated operation", async () => {
    const contract = await (await createApp().request("/openapi.json")).json();
    for (const methods of Object.values(contract.paths) as Array<Record<string, any>>) {
      for (const operation of Object.values(methods)) {
        if (!operation.security?.some((entry: Record<string, unknown>) => "bearerAuth" in entry)) continue;
        expect(operation.parameters).toContainEqual(expect.objectContaining({
          in: "header", name: "x-lifty-client-contract", required: true, schema: { type: "string", const: current },
        }));
        expect(operation.responses[409]).toBeDefined();
      }
    }
  });
});
