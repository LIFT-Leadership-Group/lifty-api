import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getAgentContext, STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import {
  AuthorizationRequiredSchema, BusinessStagePatchSchema, CampaignStagePatchSchema,
  ConnectionAttemptStatusSchema, SendingAccountStartSchema, StageOperationSchema,
  TargetingStagePatchSchema, stageOperations,
} from "../src/stage-contracts.js";

const stages = ["business", "targeting", "research-criteria", "sample-review", "commercial-voice",
  "crm", "sending-accounts", "campaigns", "notifications", "capacity"];

describe("runtime stage context", () => {
  it("publishes a bound local submission with exact receipt correlation and read-only completion operations", async () => {
    const app = createApp();
    const response = await app.request(`/v1/context/targeting?client_contract=${STAGE_CLIENT_CONTRACT}`);
    const context = await response.json();
    const plan = context.operations.post.submission;
    expect(plan).toBeDefined();
    expect(plan.version).toBe("lifty-local-submission.v1");
    expect(plan.status.match).toContainEqual({ receipt: "/submission_ref", response: "/submission_ref" });
    expect(plan.status.match).toContainEqual({ receipt: "/draft_digest", response: "/draft_digest" });
    for (const read of [plan.status, ...plan.readback]) {
      expect(context.operations[read.operation].method).toBe("GET");
    }
    expect(plan.readback[0].match).toContainEqual({ receipt: "/workspace/workspace_ref", response: "/workspace_ref" });
  });
  it("resolves every index link directly to a public current guide", async () => {
    const app = createApp();
    const response = await app.request("/v1/context/stages");
    expect(response.status).toBe(200);
    const index = await response.json();
    const links = [...index.instructions.matchAll(/\]\((\/v1\/context\/[^)]+)\)/g)].map(match => match[1]);
    expect(links).toEqual([...stages, "summary"].map(stage => `/v1/context/${stage}`));
    for (const link of links) {
      const result = await app.request(link);
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body.task).toBe(link.split("/").at(-1));
      expect(body.instructions).not.toContain("Upgrade the installed");
      expect(body.operations.get.method).toBe("GET");
    }
  });

  it.each(stages)("serves %s instructions and transport schemas without tenant access", async stage => {
    const never = async () => { throw new Error("Public context must not access private state"); };
    const app = createApp({ authenticate: never, getWorkspace: never, getConfig: never,
      getOnboardingContext: never, getConfigUpdateContext: never });
    const response = await app.request(`/v1/context/${stage}?client_contract=${STAGE_CLIENT_CONTRACT}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.format).toBe("lifty-context.v1");
    expect(body.task).toBe(stage);
    expect(body.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const section of ["Read current state", "First setup", "Later edits", "User-facing behavior and errors"]) {
      expect(body.instructions).toContain(section);
    }
    expect(body.references.common).toContain("authenticated");
    expect(body.workspace).toBeUndefined();
    expect(body.scout_global_base).toBeUndefined();
    expect(body.current_config).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(512 * 1024);
    for (const method of ["get", "post", "patch"]) {
      const operation = StageOperationSchema.parse(body.operations[method]);
      expect(operation.method).toBe(method.toUpperCase());
      expect(operation.route).toBe(`/v1/workspace/${stage}`);
      expect(operation.request.path.type).toBe("object");
      expect(operation.request.query.type).toBe("object");
      expect(operation.responses["401"]).toBeDefined();
    }
  });

  it("keeps active entry and linked workflows on published stage operations", () => {
    const contexts = [...stages, "onboarding", "workspace", "campaign"].map(task => getAgentContext(task)!);
    const guides = contexts.flatMap(context => [context.instructions, ...Object.values(context.references)]);
    // Former recommendations escaped the dynamic contract despite a working
    // generic transport. Check all reachable guide text, including references.
    for (const guide of guides) {
      expect(guide).not.toMatch(/(?:lifty )?(?:crm companies (?:context|apply)|context workspace|context campaign(?!s)|campaign linkedin|update --input|\bconnect (?:hubspot|slack|unipile|linkedin)|lifty (?:push|run|get allowance))/);
      for (const match of guide.matchAll(/stage ([a-z][a-z-]+) ([a-z][a-z_]*)/g)) {
        // Only executable instructions use stage/op pairs; ordinary prose such
        // as "stage's" and "stage GET" does not match this pattern.
        if (!Object.hasOwn(stageOperations, match[1]!)) continue;
        expect(stageOperations[match[1]!]![match[2]!], match[0]).toBeDefined();
      }
    }
    // The installed CLI/API smoke executes the served first-configuration
    // commands and checks private bindings, rejection, receipts and readback.
  });

  it("returns 404 for built-in object names and unknown tasks", async () => {
    for (const task of ["constructor", "toString", "__proto__", "unknown-stage"]) {
      const response = await createApp().request(`/v1/context/${task}?client_contract=${STAGE_CLIENT_CONTRACT}`);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("CONTEXT_NOT_FOUND");
    }
  });

  it("changes the revision when API-owned fields or routes change", () => {
    const operation = stageOperations.business!.get!;
    const original = getAgentContext("business")!;
    const oldRoute = operation.route;
    const oldQuery = operation.request.query;
    try {
      operation.route = "/v1/workspace/business-current";
      operation.request.query = { type: "object", properties: { view: { type: "string" } } };
      const changed = getAgentContext("business")!;
      expect(changed.revision).not.toBe(original.revision);
      expect(changed.operations?.get?.route).toBe(operation.route);
      expect(changed.operations?.get?.request.query).toEqual(operation.request.query);
    } finally {
      operation.route = oldRoute;
      operation.request.query = oldQuery;
    }
  });

  it("keeps unsupported writes explicit and published patch fields scoped", () => {
    for (const [stage, method] of [["capacity", "post"], ["capacity", "patch"], ["sample-review", "patch"], ["sending-accounts", "patch"]] as const) {
      const operation = stageOperations[stage]![method]!;
      expect(operation.responses["405"]).toBeDefined();
      expect(operation.responses["200"]).toBeUndefined();
      expect(operation.description).toContain("STAGE_OPERATION_UNSUPPORTED");
    }
    expect(BusinessStagePatchSchema.safeParse({ section: "workspace", values: { name: "Updated" } }).success).toBe(true);
    expect(BusinessStagePatchSchema.safeParse({ section: "workspace", values: { daily_discovery_target: 100 } }).success).toBe(false);
    expect(TargetingStagePatchSchema.safeParse({ section: "tone", values: {} }).success).toBe(false);
    expect(TargetingStagePatchSchema.safeParse({ section: "icp", values: { label: "Other", daily_target: 25 } }).success).toBe(false);
    expect(TargetingStagePatchSchema.safeParse({ section: "icp", values: { person_locations: ["Argentina"], max_stale_days: 60 } }).success).toBe(true);
    expect(stageOperations.targeting!.patch!.request.body?.properties).toMatchObject({
      section: { const: "icp" }, values: { properties: { person_locations: expect.any(Object) }, additionalProperties: false },
    });
    expect(CampaignStagePatchSchema.safeParse({ channel: "email", request: {
      operation: "activate", payload: { workspace: "demo", campaign_ref: "a".repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa", digest: "a".repeat(64) },
    } }).success).toBe(false);
  });

  it("publishes exact-attempt schemas and provider-specific handoff guidance", () => {
    const pending = { status: "pending", attempt_ref: "11111111-1111-4111-8111-111111111111", expires_at: "2026-09-16T22:00:00Z", retry_after_seconds: 3 };
    expect(ConnectionAttemptStatusSchema.safeParse(pending).success).toBe(true);
    expect(ConnectionAttemptStatusSchema.safeParse({ ...pending, retry_after_seconds: 0 }).success).toBe(false);
    expect(ConnectionAttemptStatusSchema.safeParse({ status: "connected", attempt_ref: "11111111-1111-4111-8111-111111111111", verified: true }).success).toBe(true);
    expect(ConnectionAttemptStatusSchema.safeParse({ status: "connected" }).success).toBe(false);
    for (const status of ["expired", "denied", "failed"]) {
      expect(ConnectionAttemptStatusSchema.safeParse({ status, attempt_ref: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    }
    expect(AuthorizationRequiredSchema.safeParse({ status: "authorization_required", attempt_ref: "11111111-1111-4111-8111-111111111111",
      connection_url: "https://provider.example/consent", expires_at: pending.expires_at }).success).toBe(true);
    expect(SendingAccountStartSchema.safeParse({ channel: "email" }).success).toBe(true);
    expect(SendingAccountStartSchema.safeParse({ channel: "email", select_account: true }).success).toBe(true);
    expect(SendingAccountStartSchema.safeParse({ channel: "email", select_account: "true" }).success).toBe(false);
    expect(SendingAccountStartSchema.safeParse({ channel: "email", email: "asked-before-link@example.test" }).success).toBe(false);
    for (const stage of ["crm", "sending-accounts", "notifications"]) {
      const context = getAgentContext(stage)!;
      expect(context.references.connections).toContain("retry_after_seconds");
      expect(context.references.connections).toContain("previous healthy grant");
      expect(context.references.connections).toContain("denied");
      expect(context.references.connections).toContain("localhost listener");
      expect(context.operations?.get?.request.query.properties).toHaveProperty("attempt_ref");
      expect(context.operations?.post?.responses["200"]?.required).toEqual(["status", "attempt_ref", "connection_url", "expires_at"]);
    }
    expect(getAgentContext("crm")!.instructions).toContain("HubSpot account/portal consent");
    expect(getAgentContext("notifications")!.instructions).toContain("Slack workspace consent");
    expect(getAgentContext("sending-accounts")!.instructions).toContain("hosted LinkedIn");
    expect(getAgentContext("sending-accounts")!.instructions).toContain("hosted email");
    expect(getAgentContext("sending-accounts")!.instructions).toContain('"select_account":true');
    expect(getAgentContext("sending-accounts")!.operations?.post?.request.body).toMatchObject({
      oneOf: expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({
        select_account: { type: "boolean" },
      }) })]),
    });
  });
});
