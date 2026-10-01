import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  getAgentContext,
  STAGE_CLIENT_CONTRACT,
} from "../src/agent-context.js";
import {
  AuthorizationRequiredSchema,
  ConnectionAttemptStatusSchema,
  SendingAccountStartSchema,
  stageOperations,
} from "../src/stage-contracts.js";

describe("runtime context discovery and connection handoff", () => {
  it("publishes explicit client mailbox and connection-scoped warmup operations", () => {
    const context = getAgentContext("sending-accounts")!,
      operations = context.operations!;
    expect(operations.client_accounts).toMatchObject({
      method: "GET",
      route: "/v1/email/accounts",
      request: { query: { required: ["workspace"] } },
    });
    expect(operations.client_connect).toMatchObject({
      method: "POST",
      route: "/v1/email/accounts/connect",
      request: {
        body: {
          required: ["workspace", "sender_ref", "email", "protocol_version"],
        },
      },
    });
    expect(operations.client_connect_status).toMatchObject({
      method: "POST",
      route: "/v1/email/accounts/connect/status",
      request: {
        body: {
          anyOf: [
            { required: ["workspace", "attempt_ref"] },
            { required: ["workspace", "connection_ref"] },
          ],
        },
      },
    });
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
    expect(context.instructions).toContain("Do not infer a founder workspace");
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
    expect(
      SendingAccountStartSchema.safeParse({
        channel: "email",
        select_account: true,
      }).success,
    ).toBe(true);
    expect(
      SendingAccountStartSchema.safeParse({
        channel: "email",
        select_account: "true",
      }).success,
    ).toBe(false);
    expect(
      SendingAccountStartSchema.safeParse({
        channel: "email",
        email: "asked-before-link@example.test",
      }).success,
    ).toBe(false);
    for (const stage of ["crm", "sending-accounts", "notifications"]) {
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
      "hosted LinkedIn",
    );
    expect(getAgentContext("sending-accounts")!.instructions).toContain(
      "hosted email",
    );
  });
});
