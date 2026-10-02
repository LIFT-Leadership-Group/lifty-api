import { describe, expect, it } from "vitest";


import { createCurrentClient as createApp } from "./current-client.js";
import { PublicError } from "../src/errors.js";
import { HubspotCallbackError } from "../src/hubspot-connect.js";
import { sealHubspotConnectIntent } from "../src/hubspot-state.js";
import { SlackCallbackError } from "../src/slack-connect.js";
import { sealSlackConnectIntent } from "../src/slack-state.js";

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
  it("serves the Lifty browser icon from the API host", async () => {
    const response = await createApp().request("/favicon.ico");
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/x-icon");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 1, 0]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("keeps secrets out of every public contract", async () => {
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

  const submissionFixture = (importStatus: "pending" | "imported" | "failed") => ({
    state: "submitted" as const,
    submission_ref: "11111111-1111-4111-8111-111111111111",
    draft_digest: `sha256:${"a".repeat(64)}`,
    import_status: importStatus,
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created: importStatus === "pending",
  });

  const startRunFixture = (created: boolean) => ({
    state: "queued" as const,
    run_ref: "22222222-2222-4222-8222-222222222222",
    requested_leads: 5,
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created,
  });

  it("propagates a resumed run attempt without creating another ledger run", async () => {
    const enqueued:unknown[]=[];
    const result={...startRunFixture(false),attempt:2};
    const app=createApp({authenticate:async()=>({ok:true,session:{userId:"founder",client:{}}}),startRun:async()=>result,enqueueFirstRun:async(runId,attempt)=>{enqueued.push({runId,attempt});return {id:"wake"};}});
    const response=await app.request("/v1/workspace/sample-review",{method:"POST",headers:{"x-lifty-client-contract":"lifty-cli-context.v8"}});
    expect(response.status).toBe(200);expect(await response.json()).toEqual(result);
    expect(enqueued).toEqual([{runId:result.run_ref,attempt:2}]);
  });

  it("starts the first run and enqueues exactly one job", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startRun: async () => startRunFixture(true),
      enqueueFirstRun: async (runId) => {
        enqueued.push(runId);
        return { id: "run_first" };
      },
    });

    const response = await app.request("/v1/workspace/sample-review", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v8" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(startRunFixture(true));
    expect(enqueued).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("re-attaching to an active run still re-enqueues idempotently", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startRun: async () => startRunFixture(false),
      enqueueFirstRun: async (runId) => {
        enqueued.push(runId);
        return { id: "run_first" };
      },
    });

    const response = await app.request("/v1/workspace/sample-review", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v8" },
    });

    expect(response.status).toBe(200);
    expect(enqueued).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("returns the run status for the authenticated founder", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      leads_discovered: 5,
      leads_researched: 5,
      error_code: null,
      started_at: "2026-09-01T21:00:00Z",
      completed_at: "2026-09-01T21:20:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      leads: [
        {
          name: "Pat Lopez",
          title: "VP Operations",
          company: "Acme Plants",
          linkedin_url: null,
          tier: "A",
          fit_rationale: "Owns the inspection budget.",
          stage: "qualified",
        },
      ],
    };
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getRunStatus: async () => status,
    });

    const response = await app.request("/v1/workspace/sample-review", {
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v8" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
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
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
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
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("Checking your connection");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });

  it("fails a denied HubSpot callback without attempting a token exchange", async () => {
    let completed = false;
    const response = await createApp({
      denyHubspotCallback: async () => {},
      completeHubspotCallback: async () => {
        completed = true;
        throw new Error("must not exchange");
      },
    }).request(
      `/hubspot/callback?error=access_denied&state=${sealHubspotConnectIntent("c".repeat(64), "test-secret")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Checking your connection");
    expect(completed).toBe(false);
  });

  it("gives an admin recovery path without reflecting provider error details", async () => {
    let completed = false;
    const state = sealHubspotConnectIntent("e".repeat(64), "test-secret");
    const response = await createApp({ denyHubspotCallback: async () => {}, completeHubspotCallback: async () => {
      completed = true;
      return { portalId: "123", hubDomain: null };
    }}).request(`/hubspot/callback?error=insufficient_scope&error_description=private-provider-detail&state=${state}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("super admin");
    expect(html).toContain("Approved apps");
    expect(html).not.toContain("private-provider-detail");
    expect(html).not.toContain(state);
    expect(completed).toBe(false);
  });

  it("keeps callback processing failures pending and logs no credentials", async () => {
    const marker="PRIVATE_CODE",state=sealHubspotConnectIntent("d".repeat(64),"secret"),events:unknown[]=[];
    const app=createApp({connectionCallbacks:{hubspot:{validate:()=>{},status:async()=>({status:"pending"}),
      process:async()=>{throw new Error(marker);}}},log:event=>events.push(event)});
    const response=await app.request("https://api.lifty.test/hubspot/callback/process",{method:"POST",
      headers:{origin:"https://api.lifty.test","content-type":"application/json","x-lifty-connection":"1"},body:JSON.stringify({state,code:marker})});
    expect(response.status).toBe(202);expect(await response.json()).toEqual({status:"pending"});
    expect(JSON.stringify(events)).not.toContain(marker);expect(JSON.stringify(events)).not.toContain(state);
    expect(events).toMatchObject([{event:"connection_confirmation",stage:"process",error_code:"pending"}]);
  });

  it("returns a short-lived Slack connection URL for an authenticated founder", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startSlackConnect: async (session) => {
        expect(session.userId).toBe("founder-123");
        return {
          provider: "slack",
          connect_url: "https://api.lifty.test/slack/start?intent=opaque",
          expires_in_seconds: 600,
        };
      },
    });

    const response = await app.request("/v1/integrations/slack/connect", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "slack",
      connect_url: "https://api.lifty.test/slack/start?intent=opaque",
      expires_in_seconds: 600,
    });
  });

  it("reports Slack connection status without exposing credentials", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getSlackConnection: async () => ({
        provider: "slack",
        status: "connected",
        team_id: "T123TEAM",
        team_name: "Example",
        enterprise_id: null,
        bot_user_id: "U123BOT",
        scopes: ["channels:read", "chat:write", "groups:read"],
        connected_at: "2026-09-03T14:00:00Z",
        reconnect_required: false,
      }),
    });

    const response = await app.request("/v1/integrations/slack", {
      headers: { authorization: "Bearer valid-token" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      provider: "slack",
      status: "connected",
      team_id: "T123TEAM",
      reconnect_required: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/xoxb|bot_token|secret/i);
  });

  it("redirects Slack consent and completes its callback without reflecting secrets", async () => {
    const code = "slack-authorization-code-never-reflect";
    const state = sealSlackConnectIntent("e".repeat(64), "test-secret");
    const authorizeUrl = `https://slack.com/oauth/v2/authorize?state=${state}`;
    const app = createApp({
      buildSlackAuthorizeUrl: (receivedState) => {
        expect(receivedState).toBe(state);
        return authorizeUrl;
      },
      completeSlackCallback: async (input) => {
        expect(input).toEqual({ code, state });
        return { teamId: "T123TEAM", teamName: "Example" };
      },
    });

    const start = await app.request(`/slack/start?intent=${state}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe(authorizeUrl);
    expect(start.headers.get("set-cookie")).toBeNull();

    const response = await app.request(
      `/slack/callback?code=${encodeURIComponent(code)}&state=${state}`,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Checking your connection");
    expect(html).toContain("Invite @Lifty");
    expect(html).not.toContain("terminal");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });


});

describe("LIFTY API crm sync endpoints", () => {
  const startFixture = (created: boolean) => ({
    state: "queued" as const,
    run_ref: "33333333-3333-4333-8333-333333333333",
    requested_leads: 4,
    portal_id: "149239526",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created,
  });

  it("starts the sync and enqueues exactly one job", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startCrmSyncRun: async () => startFixture(true),
      enqueueCrmSync: async (runId) => {
        enqueued.push(runId);
        return { id: "run_sync" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(startFixture(true));
    expect(enqueued).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("re-attaching to an active sync still re-enqueues idempotently", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startCrmSyncRun: async () => startFixture(false),
      enqueueCrmSync: async (runId) => {
        enqueued.push(runId);
        return { id: "run_sync" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(enqueued).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("returns the sync status for the authenticated founder", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "33333333-3333-4333-8333-333333333333",
      requested_leads: 4,
      leads_synced: 4,
      error_code: null,
      portal_id: "149239526",
      started_at: "2026-09-02T14:00:00Z",
      completed_at: "2026-09-02T14:05:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
    };
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getCrmSyncStatus: async () => status,
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it("rejects an unauthenticated sync start before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: false as const, reason: "invalid_session" as const }),
      startCrmSyncRun: async () => {
        throw new Error("must not run");
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });
});

describe("LIFTY API notification configuration", () => {
  const authenticate = async () => ({
    ok: true as const,
    session: { userId: "founder-123", client: { kind: "scoped" } },
  });
  const destinationRef = "64300000-0000-4000-a000-000000000010";
  const config = {
    workspace_ref: "64300000-0000-4000-a000-000000000001",
    notification_types: [
      "reply.requires_action",
      "meeting.booked",
      "integration.disconnected",
      "system.test",
    ] as Array<
      | "reply.requires_action"
      | "meeting.booked"
      | "integration.disconnected"
      | "system.test"
    >,
    slack: {
      status: "connected" as const,
      team_id: "T643TEAM",
      team_name: "Example",
      reconnect_required: false,
    },
    destinations: [{
      destination_ref: destinationRef,
      provider: "slack" as const,
      external_id: "C643CHANNEL",
      display_name: "client-alerts",
      status: "active" as const,
    }],
    routes: [{
      route_ref: "64300000-0000-4000-a000-000000000011",
      notification_type: "reply.requires_action" as const,
      destination_ref: destinationRef,
      enabled: true,
    }],
  };

  it("reads the secret-free routing matrix and live invited Slack channels", async () => {
    const app = createApp({
      authenticate,
      getNotificationConfig: async () => config,
      listSlackNotificationChannels: async () => ({
        channels: [
          { id: "C643CHANNEL", name: "client-alerts", is_private: false },
          { id: "C643PRIVATE", name: "founders", is_private: true },
        ],
      }),
    });

    const configResponse = await app.request("/v1/notifications", {
      headers: { authorization: "Bearer valid-token" },
    });
    const channelsResponse = await app.request(
      "/v1/notifications/slack/channels",
      { headers: { authorization: "Bearer valid-token" } },
    );

    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toEqual(config);
    expect(channelsResponse.status).toBe(200);
    expect(await channelsResponse.json()).toEqual({
      channels: [
        { id: "C643CHANNEL", name: "client-alerts", is_private: false },
        { id: "C643PRIVATE", name: "founders", is_private: true },
      ],
    });
    expect(JSON.stringify(config)).not.toMatch(/bot_token|xoxb|secret/i);
  });

  it("upserts a destination and toggles a registered route", async () => {
    const calls: unknown[] = [];
    const app = createApp({
      authenticate,
      upsertNotificationDestination: async (_session, input) => {
        calls.push({ destination: input });
        return config.destinations[0]!;
      },
      setNotificationRoute: async (_session, input) => {
        calls.push({ route: input });
        return config.routes[0]!;
      },
    });

    const destination = await app.request("/v1/notifications/destinations/slack", {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel_id: "C643CHANNEL", channel_name: "client-alerts" }),
    });
    const route = await app.request("/v1/notifications/routes", {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        notification_type: "reply.requires_action",
        destination_ref: destinationRef,
        enabled: true,
      }),
    });

    expect(destination.status).toBe(200);
    expect(route.status).toBe(200);
    expect(calls).toEqual([
      { destination: { channel_id: "C643CHANNEL", channel_name: "client-alerts" } },
      {
        route: {
          notification_type: "reply.requires_action",
          destination_ref: destinationRef,
          enabled: true,
        },
      },
    ]);
  });

  it("enqueues system.test delivery immediately after the RPC creates it", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate,
      enqueueNotificationTest: async () => ({
        delivery_ref: "64300000-0000-4000-a000-000000000012",
        destination_ref: destinationRef,
        status: "queued" as const,
      }),
      enqueueNotificationDelivery: async (deliveryRef) => {
        enqueued.push(deliveryRef);
        return { id: "run_notification" };
      },
    });

    const response = await app.request(
      `/v1/notifications/destinations/${destinationRef}/test`,
      { method: "POST", headers: { authorization: "Bearer valid-token" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivery_ref: "64300000-0000-4000-a000-000000000012",
      destination_ref: destinationRef,
      status: "queued",
    });
    expect(enqueued).toEqual(["64300000-0000-4000-a000-000000000012"]);
  });

  it("rejects an unknown notification type before the write RPC", async () => {
    let called = false;
    const app = createApp({
      authenticate,
      setNotificationRoute: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    const response = await app.request("/v1/notifications/routes", {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        notification_type: "invented.event",
        destination_ref: destinationRef,
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});
