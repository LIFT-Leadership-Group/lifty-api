import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { PublicError } from "../src/errors.js";

describe("LIFTY API", () => {
  it("publishes the versioned REST contract as generated OpenAPI", async () => {
    const app = createApp();

    const response = await app.request("/openapi.json");
    const document = await response.json() as {
      openapi?: string;
      paths?: Record<string, Record<string, { operationId?: string }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths?.["/v1/workspace"]?.get?.operationId).toBe(
      "getWorkspaceStatus",
    );
    expect(document.paths?.["/v1/workspaces"]?.post?.operationId).toBe(
      "provisionWorkspace",
    );
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("serves an unauthenticated health check with a correlation id", async () => {
    const app = createApp();

    const response = await app.request("/healthz", {
      headers: { "x-request-id": "req-health-123" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-health-123");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves readiness only after the configured app exists", async () => {
    const response = await createApp().request("/readyz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("rejects an unauthenticated workspace request before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: false, reason: "invalid_session" }),
    });

    const response = await app.request("/v1/workspace", {
      headers: { "x-request-id": "req-auth-123" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "A valid LIFTY session is required.",
      },
      request_id: "req-auth-123",
    });
  });

  it("returns the authenticated founder's workspace status", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async (session) => {
        if (session.userId !== "founder-123") throw new Error("wrong actor");
        return {
          state: "ready_for_connections",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          next_action: null,
        };
      },
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ready_for_connections",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      next_action: null,
    });
  });

  it("provisions a workspace from the authenticated founder's draft", async () => {
    const draft = { schema_version: "1.0", status: "ready_for_auth" };
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      provisionWorkspace: async (session, receivedDraft) => {
        if (session.userId !== "founder-123") throw new Error("wrong actor");
        if (JSON.stringify(receivedDraft) !== JSON.stringify(draft)) {
          throw new Error("wrong draft");
        }
        return {
          state: "ready_for_connections",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          draft_digest: `sha256:${"a".repeat(64)}`,
        };
      },
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ draft }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ready_for_connections",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      draft_digest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("rejects a malformed provisioning envelope without echoing its content", async () => {
    const secretMarker = "founder-private-content";
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "x-request-id": "req-invalid-123",
      },
      body: JSON.stringify({ draft: [secretMarker] }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).not.toContain(secretMarker);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "The provisioning request must contain one JSON object named draft.",
      },
      request_id: "req-invalid-123",
    });
  });

  it("rejects an oversized provisioning request before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "x-request-id": "req-large-123",
      },
      body: JSON.stringify({ draft: { value: "x".repeat(133 * 1024) } }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The provisioning request exceeds 132 KiB.",
      },
      request_id: "req-large-123",
    });
  });

  it("rejects a declared oversized body before reading or provisioning it", async () => {
    let provisioned = false;
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      provisionWorkspace: async () => {
        provisioned = true;
        throw new Error("must not provision");
      },
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "content-length": String(133 * 1024),
      },
      body: JSON.stringify({ draft: { schema_version: "1.0" } }),
    });

    expect(response.status).toBe(413);
    expect(provisioned).toBe(false);
  });

  it("translates a known provisioning conflict without leaking private details", async () => {
    const privateMarker = "private-database-detail";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      provisionWorkspace: async () => {
        throw new PublicError({
          status: 409,
          code: "WORKSPACE_ALREADY_EXISTS",
          message: "This LIFTY account already has a workspace.",
          cause: new Error(privateMarker),
        });
      },
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "x-request-id": "req-conflict-123",
      },
      body: JSON.stringify({ draft: { schema_version: "1.0" } }),
    });
    const responseText = await response.text();
    const logText = JSON.stringify(logEvents);

    expect(response.status).toBe(409);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "WORKSPACE_ALREADY_EXISTS",
        message: "This LIFTY account already has a workspace.",
      },
      request_id: "req-conflict-123",
    });
    expect(responseText).not.toContain(privateMarker);
    expect(logText).not.toContain(privateMarker);
    expect(logEvents).toEqual([
      {
        level: "warn",
        event: "request_failed",
        request_id: "req-conflict-123",
        method: "POST",
        path: "/v1/workspaces",
        error_code: "WORKSPACE_ALREADY_EXISTS",
        status: 409,
      },
    ]);
  });
});
