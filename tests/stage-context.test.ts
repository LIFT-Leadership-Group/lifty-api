import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";
import { RPC_ERROR_MESSAGES } from "../src/rpc-errors.js";
import {
  getAgentContext,
  STAGE_CLIENT_CONTRACT,
} from "../src/agent-context.js";
import {
  AuthorizationRequiredSchema,
  ConnectionAttemptStatusSchema,
  stageOperations,
} from "../src/stage-contracts.js";

describe("runtime context discovery and connection handoff", () => {
  it("publishes the Identity catalog and connection-scoped warmup operations", () => {
    const context = getAgentContext("sending-accounts")!,
      operations = context.operations!;
    expect(Object.fromEntries(Object.entries(operations).filter(([key]) => !/^(warmup_|placement_|deliverability)/.test(key))
      .map(([key, operation]) => [key, `${operation.method} ${operation.route}`]))).toEqual({
      context: "GET /v1/context/sending-accounts",
      get: "GET /v1/workspace/sending-accounts",
      connect: "POST /v1/workspace/sending-accounts/connect",
      attempt: "GET /v1/workspace/sending-accounts/attempts/{id}",
      reconnect: "POST /v1/workspace/sending-accounts/{id}/reconnect",
      pause: "POST /v1/workspace/sending-accounts/{id}/pause",
      resume: "POST /v1/workspace/sending-accounts/{id}/resume",
      disconnect: "POST /v1/workspace/sending-accounts/{id}/disconnect",
    });
    expect(operations.connect!.request.body).toMatchObject({ required: ["sender_id", "channel"], additionalProperties: false });
    expect(Object.keys(operations.disconnect!.responses)).toEqual(expect.arrayContaining(["200", "202"]));
    expect(Object.fromEntries(Object.entries(getAgentContext("senders")!.operations!).map(([key, operation]) => [key, `${operation.method} ${operation.route}`]))).toEqual({
      context: "GET /v1/context/senders",
      get: "GET /v1/workspace/senders",
      post: "POST /v1/workspace/senders",
      patch: "PATCH /v1/workspace/senders/{id}",
      delete: "POST /v1/workspace/senders/{id}/delete",
    });
    expect(getAgentContext("senders")!.instructions).toContain("lifty post senders delete");
    expect(getAgentContext("senders")!.instructions).toContain("lifty context senders");
    for (const action of ["status", "start", "pause", "resume", "remove"]) {
      const operation = operations[`warmup_${action}`]!;
      expect(operation.route).toBe(
        `/v1/email/warmup${action === "status" ? "" : `/${action}`}`,
      );
      expect(
        action === "status" ? operation.request.query : operation.request.body,
      ).toMatchObject({
        properties: {
          workspace: expect.any(Object),
          connection_ref: expect.any(Object),
        },
      });
    }
    expect(getAgentContext("senders")!.instructions).toContain("they are never identifiers");
    expect(context.instructions).toContain(
      "Warmup resume never resumes campaigns",
    );
    expect(context.instructions).toContain(
      "Warmup setup uses Google OAuth only",
    );
    expect(context.instructions).toContain("Never request an App Password");
  });
  it("resolves every generated index link without authentication or tenant reads", async () => {
    const never = async () => {
      throw Error("Public context must not access tenant state");
    };
    const app = createApp({
      authenticate: never,
      businessOperation: never,
      listMemberWorkspaces: never,
    });
    const index = await (
      await app.request(
        `/v1/context/stages?client_contract=${STAGE_CLIENT_CONTRACT}`,
      )
    ).json();
    const links = [
      ...index.instructions.matchAll(/\]\((\/v1\/context\/[^)]+)\)/g),
    ].map((match) => match[1]);
    expect(links).toEqual(
      Object.keys(stageOperations).map((stage) => `/v1/context/${stage}`),
    );
    for (const link of links) {
      const response = await app.request(link);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const context = await response.json();
      expect(context.task).toBe(link.split("/").at(-1));
      expect(context.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(context.workspace).toBeUndefined();
      expect(context.scout_global_base).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(
        512 * 1024,
      );
    }
  });
  it("rejects built-in object names and unknown tasks", async () => {
    for (const task of [
      "constructor",
      "toString",
      "__proto__",
      "unknown-stage",
    ]) {
      const response = await createApp().request(
        `/v1/context/${task}?client_contract=${STAGE_CLIENT_CONTRACT}`,
      );
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("CONTEXT_NOT_FOUND");
    }
  });
  it("updates the revision, schema and executable guidance when a catalog route changes", () => {
    const operation = stageOperations.business!.get!;
    const original = getAgentContext("business")!;
    const oldRoute = operation.route;
    const oldQuery = operation.request.query;
    try {
      operation.route = "/v1/workspace/business-current";
      operation.request.query = {
        type: "object",
        properties: { view: { type: "string" } },
      };
      const changed = getAgentContext("business")!;
      expect(changed.revision).not.toBe(original.revision);
      expect(changed.operations?.get?.route).toBe(operation.route);
      expect(changed.operations?.get?.request.query).toEqual(
        operation.request.query,
      );
      expect(changed.instructions).toContain(operation.route);
    } finally {
      operation.route = oldRoute;
      operation.request.query = oldQuery;
    }
  });
  it("retains exact-attempt schemas and connection handoff guidance", () => {
    const pending = {
      status: "pending",
      attempt_ref: "11111111-1111-4111-8111-111111111111",
      expires_at: "2026-09-16T22:00:00Z",
      retry_after_seconds: 3,
    };
    expect(ConnectionAttemptStatusSchema.safeParse(pending).success).toBe(true);
    expect(
      ConnectionAttemptStatusSchema.safeParse({
        ...pending,
        retry_after_seconds: 0,
      }).success,
    ).toBe(false);
    expect(
      ConnectionAttemptStatusSchema.safeParse({
        status: "connected",
        attempt_ref: pending.attempt_ref,
        verified: true,
      }).success,
    ).toBe(true);
    expect(
      ConnectionAttemptStatusSchema.safeParse({ status: "connected" }).success,
    ).toBe(false);
    for (const status of ["expired", "denied", "failed"])
      expect(
        ConnectionAttemptStatusSchema.safeParse({
          status,
          attempt_ref: pending.attempt_ref,
        }).success,
      ).toBe(true);
    expect(
      AuthorizationRequiredSchema.safeParse({
        status: "authorization_required",
        attempt_ref: pending.attempt_ref,
        connection_url: "https://provider.example/consent",
        expires_at: pending.expires_at,
      }).success,
    ).toBe(true);
    for (const stage of ["crm", "notifications"]) {
      const context = getAgentContext(stage)!;
      expect(context.references.connections).toContain("retry_after_seconds");
      expect(context.references.connections).toContain(
        "previous healthy grant",
      );
      expect(context.references.connections).toContain("denied");
      expect(context.operations?.get?.request.query.properties).toHaveProperty(
        "attempt_ref",
      );
      expect(context.operations?.post?.responses["200"]?.required).toEqual([
        "status",
        "attempt_ref",
        "connection_url",
        "expires_at",
      ]);
    }
    expect(getAgentContext("crm")!.instructions).toContain(
      "HubSpot account/portal consent",
    );
    expect(getAgentContext("notifications")!.instructions).toContain(
      "Slack workspace consent",
    );
    expect(getAgentContext("sending-accounts")!.instructions).toContain(
      "Lifty's connect page asks the person's declaration",
    );
    expect(getAgentContext("sending-accounts")!.references.connections).toBeUndefined();
  });
});

// LIF-1174, LIF-1182, LIF-1190 (D4): the acquisition and sending-account providers
// and the retired volume knobs never reach a customer surface. Operators see
// provider details in logs and alerts only.
describe("customer surfaces name no provider or retired volume knob", () => {
  const retired = /apollo|unipile|heyreach|allowance|capacity|daily_discovery_target|pipeline_active|tier_1|tier_2/i;
  const source = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? source(`${dir}${entry.name}/`)
      : entry.name.endsWith(".ts") ? [readFileSync(new URL(`${dir}${entry.name}`, import.meta.url), "utf8")] : []);
  // Every public error code a route or adapter can return.
  const publicCodes = source("../src/").flatMap(text => [
    ...text.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]+)"/g),
    ...text.matchAll(/errorJson\([^,]+,\s*\d+,\s*"([A-Z][A-Z0-9_]+)"/g),
  ].map(match => match[1]!));
  it("scans the catalog, OpenAPI, MCP tools, every guide, every public error code and every route", async () => {
    const guides = readdirSync(new URL("../src/agent-context/", import.meta.url)).filter(name => name.endsWith(".md"));
    expect(guides).toEqual(expect.arrayContaining(["research-schedule.md", "leads.md"]));
    const app = createApp();
    const surfaces: Record<string, string> = {
      catalog: JSON.stringify(stageOperations),
      openapi: await (await app.request("/openapi.json")).text(),
      routes: JSON.stringify(app.routes.map(route => route.path)),
      mcp: JSON.stringify(getStageMcpTools()),
      rpc_errors: JSON.stringify(RPC_ERROR_MESSAGES),
      public_codes: publicCodes.join(" "),
      ...Object.fromEntries(["stages", "campaign", ...Object.keys(stageOperations)].map(task => [`context:${task}`, JSON.stringify(getAgentContext(task))])),
      ...Object.fromEntries(guides.map(name => [name, readFileSync(new URL(`../src/agent-context/${name}`, import.meta.url), "utf8")])),
    };
    // The scanner must actually see codes, or an empty scan would pass.
    expect(publicCodes).toEqual(expect.arrayContaining(["RESEARCH_STATUS_UNAVAILABLE", "LEADS_UNAVAILABLE", "STAGE_OPERATION_UNSUPPORTED"]));
    for (const [name, text] of Object.entries(surfaces)) expect(text.match(retired)?.[0], name).toBeUndefined();
  });
  it("keeps the sample's operations to get, post and progress", () => {
    expect(Object.keys(stageOperations["sample-review"]!).sort()).toEqual(["get", "post", "progress"]);
    expect(getStageMcpTools().map(tool => tool.name).filter(name => /recovery|capacity|allowance|apollo/.test(name))).toEqual([]);
  });
});
