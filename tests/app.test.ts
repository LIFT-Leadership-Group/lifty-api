import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { PublicError } from "../src/errors.js";
import { HubspotCallbackError } from "../src/hubspot-connect.js";
import { sealHubspotConnectIntent } from "../src/hubspot-state.js";

const SECRET_FIELD_NAME = /token$|api_?key|secret|credential/i;

function collectSecretBearingFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectSecretBearingFieldNames);
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(SECRET_FIELD_NAME.test(key) ? [key] : []),
    ...collectSecretBearingFieldNames(child),
  ]);
}

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
    expect(document.paths?.["/v1/workspace"]?.post?.operationId).toBe(
      "createWorkspace",
    );
    expect(document.paths?.["/v1/workspaces"]?.post?.operationId).toBe(
      "provisionWorkspace",
    );
    expect(
      document.paths?.["/v1/integrations/hubspot/connect"]?.post?.operationId,
    ).toBe("startHubspotConnect");
    expect(
      document.paths?.["/v1/integrations/hubspot"]?.get?.operationId,
    ).toBe("getHubspotConnection");
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("keeps secret-bearing fields out of every public OpenAPI contract", async () => {
    const document = await (await createApp().request("/openapi.json")).json();

    expect(collectSecretBearingFieldNames(document)).toEqual([]);
    expect(collectSecretBearingFieldNames({
      access_token: { type: "string" },
      providerToken: { type: "string" },
    })).toEqual(["access_token", "providerToken"]);
  });

  it("serves an unauthenticated health check with a correlation id", async () => {
    const app = createApp();

    const response = await app.request("/healthz", {
      headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("replaces an untrusted request id before reflecting or logging it", async () => {
    const privateMarker = "founder-private-content";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async () => {
        throw new Error("failed safely");
      },
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspace", {
      headers: {
        authorization: "Bearer valid-token",
        "x-request-id": privateMarker,
      },
    });
    const responseText = await response.text();
    const responseId = response.headers.get("x-request-id");

    expect(response.status).toBe(500);
    expect(responseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(responseText).not.toContain(privateMarker);
    expect(JSON.stringify(logEvents)).not.toContain(privateMarker);
    expect(logEvents).toMatchObject([{ request_id: responseId }]);
  });

  it("serves readiness only after the configured app exists", async () => {
    const response = await createApp().request("/readyz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("reports 503 when the readiness dependency says the backend is unreachable", async () => {
    const app = createApp({ checkReadiness: async () => false });

    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unready" });
  });

  it("reports 503 when the readiness dependency throws", async () => {
    const app = createApp({
      checkReadiness: async () => {
        throw new Error("supabase unreachable");
      },
    });

    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unready" });
  });

  it("rejects an unauthenticated workspace request before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: false, reason: "invalid_session" }),
    });

    const response = await app.request("/v1/workspace", {
      headers: { "x-request-id": "22222222-2222-4222-8222-222222222222" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "A valid LIFTY session is required.",
      },
      request_id: "22222222-2222-4222-8222-222222222222",
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

  it("rejects a secret-bearing workspace result before serializing or logging it", async () => {
    const providerToken = "synthetic-provider-token-never-surface";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: {
          workspace_ref: "ws_opaque",
          name: "Example",
          access_token: providerToken,
        },
        next_action: null,
      } as never),
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer valid-token" },
    });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(providerToken);
    expect(JSON.stringify(logEvents)).not.toContain(providerToken);
  });

  it("creates the login workspace for the authenticated founder", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      createWorkspace: async (session, input) => {
        if (session.userId !== "founder-123") throw new Error("wrong actor");
        if (input.name !== "Example" || input.description !== "Example helps founders.") {
          throw new Error("wrong input");
        }
        return {
          state: "ready_for_connections",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          created: true,
        };
      },
    });

    const response = await app.request("/v1/workspace", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Example", description: "Example helps founders." }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ready_for_connections",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      created: true,
    });
  });

  it("rejects a malformed create-workspace body before business logic", async () => {
    let called = false;
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      createWorkspace: async () => {
        called = true;
        throw new Error("must not be reached");
      },
    });

    const response = await app.request("/v1/workspace", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "x-request-id": "33333333-3333-4333-8333-333333333333",
      },
      body: JSON.stringify({ name: "   ", extra: true }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "The workspace request must contain a non-empty name and an optional description.",
      },
      request_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects a declared oversized create-workspace body before reading it", async () => {
    let called = false;
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      createWorkspace: async () => {
        called = true;
        throw new Error("must not be reached");
      },
    });

    const response = await app.request("/v1/workspace", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
        "content-length": String(64 * 1024),
      },
      body: JSON.stringify({ name: "Example" }),
    });

    expect(response.status).toBe(413);
    expect(called).toBe(false);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
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

  it("rejects a secret-bearing provisioning result before serializing or logging it", async () => {
    const providerToken = "synthetic-provider-token-never-surface";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      provisionWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: { workspace_ref: "ws_opaque", name: "Example" },
        draft_digest: `sha256:${"a".repeat(64)}`,
        api_key: providerToken,
      } as never),
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ draft: { schema_version: "1.0" } }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(providerToken);
    expect(JSON.stringify(logEvents)).not.toContain(providerToken);
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
        "x-request-id": "33333333-3333-4333-8333-333333333333",
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
      request_id: "33333333-3333-4333-8333-333333333333",
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
        "x-request-id": "44444444-4444-4444-8444-444444444444",
      },
      body: JSON.stringify({ draft: { value: "x".repeat(133 * 1024) } }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The provisioning request exceeds 132 KiB.",
      },
      request_id: "44444444-4444-4444-8444-444444444444",
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

  it("stops consuming a streamed body as soon as it exceeds the limit", async () => {
    let pulls = 0;
    let cancelled = false;
    let provisioned = false;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 8) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
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
    const request = new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(8);
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
        "x-request-id": "55555555-5555-4555-8555-555555555555",
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
      request_id: "55555555-5555-4555-8555-555555555555",
    });
    expect(responseText).not.toContain(privateMarker);
    expect(logText).not.toContain(privateMarker);
    expect(logEvents).toEqual([
      {
        level: "warn",
        event: "request_failed",
        request_id: "55555555-5555-4555-8555-555555555555",
        method: "POST",
        path: "/v1/workspaces",
        error_code: "WORKSPACE_ALREADY_EXISTS",
        status: 409,
      },
    ]);
  });

  it("returns a short-lived HubSpot connection URL for an authenticated founder", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startHubspotConnect: async (session) => {
        expect(session.userId).toBe("founder-123");
        return {
          provider: "hubspot",
          connect_url: "https://api.lifty.test/hubspot/start?intent=opaque",
          expires_in_seconds: 600,
        };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/connect", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "hubspot",
      connect_url: "https://api.lifty.test/hubspot/start?intent=opaque",
      expires_in_seconds: 600,
    });
  });

  it("reports HubSpot connection status without exposing credentials", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getHubspotConnection: async () => ({
        provider: "hubspot",
        status: "connected",
        portal_id: "49072478",
        hub_domain: "example.test",
        granted_scopes: ["oauth"],
        connected_at: "2026-08-31T16:00:00Z",
        reconnect_required: false,
      }),
    });

    const response = await app.request("/v1/integrations/hubspot", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "hubspot",
      status: "connected",
      portal_id: "49072478",
      hub_domain: "example.test",
      granted_scopes: ["oauth"],
      connected_at: "2026-08-31T16:00:00Z",
      reconnect_required: false,
    });
  });

  it("redirects a valid one-time intent to HubSpot consent without cookies", async () => {
    const state = sealHubspotConnectIntent("a".repeat(64), "test-secret");
    const authorizeUrl = `https://app.hubspot.com/oauth/authorize?state=${state}`;
    const app = createApp({
      buildHubspotAuthorizeUrl: (receivedState) => {
        expect(receivedState).toBe(state);
        return authorizeUrl;
      },
    });

    const response = await app.request(`/hubspot/start?intent=${state}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(authorizeUrl);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves CLI login from the hosted runtime with strict no-store headers", async () => {
    const rendered: Array<{ state: string; port: number }> = [];
    const response = await createApp({
      renderCliAuthPage: (state, port) => {
        rendered.push({ state, port });
        return {
          html: "<!doctype html><title>Authorize LIFTY</title>",
          scriptNonce: "test-nonce-value",
        };
      },
    }).request(`/cli/auth?state=${"s".repeat(43)}&port=49152`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-test-nonce-value'",
    );
    expect(rendered).toEqual([{ state: "s".repeat(43), port: 49152 }]);
  });

  it("rejects invalid CLI login parameters before rendering auth", async () => {
    let rendered = false;
    const app = createApp({
      renderCliAuthPage: () => {
        rendered = true;
        return { html: "must not render", scriptNonce: "unused" };
      },
    });

    expect((await app.request("/cli/auth?state=bad state&port=49152")).status)
      .toBe(400);
    expect((await app.request("/cli/auth?state=safe&port=80")).status).toBe(400);
    expect(rendered).toBe(false);
  });

  it("rejects malformed HubSpot intents before building an authorization URL", async () => {
    let built = false;
    const response = await createApp({
      buildHubspotAuthorizeUrl: () => {
        built = true;
        return "https://must-not-open.example";
      },
    }).request("/hubspot/start?intent=not-a-capability");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(built).toBe(false);
  });

  it("completes a HubSpot callback without reflecting its code or state", async () => {
    const code = "provider-authorization-code-never-reflect";
    const state = sealHubspotConnectIntent("b".repeat(64), "test-secret");
    const app = createApp({
      completeHubspotCallback: async (input) => {
        expect(input).toEqual({ code, state });
        return { portalId: "49072478", hubDomain: "example.test" };
      },
    });

    const response = await app.request(
      `/hubspot/callback?code=${encodeURIComponent(code)}&state=${state}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("HubSpot is connected");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });

  it("fails a denied HubSpot callback without attempting a token exchange", async () => {
    let completed = false;
    const response = await createApp({
      completeHubspotCallback: async () => {
        completed = true;
        throw new Error("must not exchange");
      },
    }).request(
      `/hubspot/callback?error=access_denied&state=${sealHubspotConnectIntent("c".repeat(64), "test-secret")}`,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("HubSpot authorization was cancelled");
    expect(completed).toBe(false);
  });

  it("logs only a safe callback reason when completion fails", async () => {
    const providerToken = "synthetic-provider-token-never-surface";
    const logEvents: unknown[] = [];
    const response = await createApp({
      completeHubspotCallback: async () => {
        throw new HubspotCallbackError(
          "exchange_failed",
          502,
          "HubSpot did not accept the authorization.",
        );
      },
      log: (event) => logEvents.push(event),
    }).request(
      `/hubspot/callback?code=${providerToken}&state=${sealHubspotConnectIntent("d".repeat(64), "test-secret")}`,
    );
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).not.toContain(providerToken);
    expect(JSON.stringify(logEvents)).not.toContain(providerToken);
    expect(logEvents).toMatchObject([{
      error_code: "HUBSPOT_CALLBACK_EXCHANGE_FAILED",
      method: "GET",
      path: "/hubspot/callback",
      status: 502,
    }]);
  });
});
