import { describe, expect, it } from "vitest";import { createCrmSyncTrigger, createCrmMappingTrigger, createFirstRunTrigger, createNotificationDeliveryTrigger } from "../src/trigger-client.js";

const settings = {
  apiUrl: "https://api.trigger.test",
  secretKey: "tr_prod_test_key",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}


describe("first run trigger client", () => {
  it("dedupes reattachment per attempt and wakes resumed runs with a fresh key", async () => {
    const bodies: Array<{payload:{runId:string;attempt:number};options:{idempotencyKey:string}}> = [];
    const enqueue=createFirstRunTrigger({...settings,fetchImpl:(async (_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return jsonResponse(200,{id:"run"});}) as typeof fetch});
    await enqueue("ledger",1);await enqueue("ledger",1);await enqueue("ledger",2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies.map(body=>body.options.idempotencyKey)).toEqual(["lifty-first-run:ledger:1","lifty-first-run:ledger:1","lifty-first-run:ledger:2"]);
    expect(bodies[2]?.payload).toEqual({runId:"ledger",attempt:2});
    for(const invalid of [-1,1.5,NaN])await expect(enqueue("ledger",invalid)).rejects.toMatchObject({code:"IMPORT_ENQUEUE_FAILED"});
    expect(bodies).toHaveLength(3);
  });
  it("enqueues lifty-first-run with a run-scoped idempotency key", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const enqueue = createFirstRunTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, { id: "run_first" });
      }) as typeof fetch,
    });

    const run = await enqueue("22222222-2222-4222-8222-222222222222");

    expect(run).toEqual({ id: "run_first" });
    expect(requests[0]?.url).toBe(
      "https://api.trigger.test/api/v1/tasks/lifty-first-run/trigger",
    );
    expect(requests[0]?.body).toEqual({
      payload: { runId: "22222222-2222-4222-8222-222222222222", attempt: 0 },
      options: {
        idempotencyKey: "lifty-first-run:22222222-2222-4222-8222-222222222222:0",
        idempotencyKeyTTL: "1h",
      },
    });
  });
});

describe("crm sync trigger client", () => {
  it("enqueues lifty-crm-sync with a run-scoped idempotency key", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const enqueue = createCrmSyncTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, { id: "run_sync" });
      }) as typeof fetch,
    });

    const run = await enqueue("33333333-3333-4333-8333-333333333333");

    expect(run).toEqual({ id: "run_sync" });
    expect(requests[0]?.url).toBe(
      "https://api.trigger.test/api/v1/tasks/lifty-crm-sync/trigger",
    );
    expect(requests[0]?.body).toEqual({
      payload: { runId: "33333333-3333-4333-8333-333333333333" },
      options: {
        idempotencyKey: "lifty-crm-sync:33333333-3333-4333-8333-333333333333",
        idempotencyKeyTTL: "1h",
      },
    });
  });
});

describe("crm mapping replay trigger client", () => {
  it("reattaches the exact saved mapping run with a ledger-scoped idempotency key", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const enqueue = createCrmMappingTrigger({ ...settings, fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse(200, { id: "run_mapping" });
    } });
    const runRef = "33333333-3333-4333-8333-333333333333";
    const workspaceRef = "22222222-2222-4222-8222-222222222222";
    await enqueue(runRef, workspaceRef);
    await enqueue(runRef, workspaceRef);
    expect(requests[0]).toEqual({
      url: "https://api.trigger.test/api/v1/tasks/lifty-crm-mapping-sync/trigger",
      body: { payload: { runRef }, options: {
        idempotencyKey: `lifty-crm-mapping-sync:${runRef}`, idempotencyKeyTTL: "1h",
      } },
    });
    expect(requests[1]).toEqual(requests[0]);
  });
});

describe("notification delivery trigger client", () => {
  it("enqueues the exact delivery with a delivery-scoped idempotency key", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const enqueue = createNotificationDeliveryTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, { id: "run_notification" });
      }) as typeof fetch,
    });
    const deliveryId = "64300000-0000-4000-a000-000000000012";

    await enqueue(deliveryId);

    expect(requests).toEqual([{
      url: "https://api.trigger.test/api/v1/tasks/notification-delivery/trigger",
      body: {
        payload: { deliveryId },
        options: {
          idempotencyKey: `notification-delivery:${deliveryId}`,
          idempotencyKeyTTL: "1h",
        },
      },
    }]);
  });
});
