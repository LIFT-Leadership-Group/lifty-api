import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SUPPORTED_CLIENT_CONTRACTS } from "../src/agent-context.js";
import { stageOperations } from "../src/stage-contracts.js";

// What installed clients already depend on. @liftleadershipgroup/lifty
// 0.1.0-next.35 implements lifty-cli-context.v11; founders are not asked to
// update for API releases (LIF-1293). A failure here means the change breaks
// installed clients: keep the old shape, or make it a deliberate transport
// change with a new contract and client release.
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Routes each client calls without the operation catalog (its dist/cli.js).
const directRoutes: Record<string, readonly (readonly [string, string])[]> = {
  "lifty-cli-context.v11": [["GET", "/v1/me/workspaces"], ["GET", "/v1/workspace/summary"]],
};

describe("installed clients", () => {
  it("keep the transport contracts they send", () => {
    // Change only with the transport itself, never for an API or context release.
    expect(SUPPORTED_CLIENT_CONTRACTS).toEqual(Object.keys(directRoutes));
  });

  it("receive every context in the envelope and catalog shape they validate", async () => {
    const app = createApp();
    for (const [contract, task] of SUPPORTED_CLIENT_CONTRACTS.flatMap(contract =>
      ["stages", ...Object.keys(stageOperations)].map(task => [contract, task] as const))) {
      const response = await app.request(`/v1/context/${task}?client_contract=${contract}`);
      expect(response.status, task).toBe(200);
      expect(response.headers.get("content-type"), task).toMatch(/^application\/json(?:\s*;|$)/i);
      const value = await response.json();
      // The client's readTaskContext check.
      expect(object(value) && value.format === "lifty-context.v1" && value.task === task
        && /^sha256:[a-f0-9]{64}$/.test(String(value.revision))
        && typeof value.instructions === "string" && value.instructions.trim() !== ""
        && object(value.schemas) && Object.values(value.schemas).every(object)
        && object(value.references) && Object.values(value.references).every(item => typeof item === "string"), task).toBe(true);
      // The client's resolveStageOperation and request builder: one command per
      // method and name, and routes made of literal segments or whole placeholders.
      const commands = new Set<string>();
      for (const [key, operation] of Object.entries((value.operations ?? {}) as Record<string, { method: string; route: string; cli?: { operation?: string } }>)) {
        const name = `${task}.${key}`;
        expect(["GET", "POST", "PATCH", "DELETE"], name).toContain(operation.method);
        expect(operation.route, name).toMatch(/^\/v1\/[A-Za-z0-9_{}/-]+$/);
        for (const segment of operation.route.split("/").slice(1))
          expect(segment, name).toMatch(/^(?:[A-Za-z0-9_-]+|\{.+\})$/);
        const command = `${operation.method} ${operation.cli?.operation ?? key}`;
        expect(commands.has(command), `${task}: ${command}`).toBe(false);
        commands.add(command);
      }
    }
  });

  it("keep reaching the routes they call directly", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      log: () => {},
    });
    for (const [contract, method, path] of Object.entries(directRoutes).flatMap(([contract, routes]) =>
      routes.map(([method, path]) => [contract, method, path] as const))) {
      const response = await app.request(path, {
        method,
        headers: { authorization: "Bearer founder", "x-lifty-client-contract": contract, "content-type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      // An unrouted path gets the framework's plain-text 404; a routed one
      // answers in JSON even when its dependencies are not configured.
      expect(response.headers.get("content-type") ?? "", `${contract} ${method} ${path} returned ${response.status}`).toMatch(/application\/json/);
      expect(response.status, `${contract} ${method} ${path}`).not.toBe(409);
    }
  });
});
