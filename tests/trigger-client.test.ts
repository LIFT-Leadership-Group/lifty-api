import { describe, expect, it } from "vitest";

import {
  createCrmSyncTrigger,
  createCrmMappingTrigger,
  createFirstRunTrigger,
  createNotificationDeliveryTrigger,
  createOnboardingImportTrigger,
} from "../src/trigger-client.js";

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

describe("onboarding import trigger client", () => {
  it("enqueues the task with a submission-scoped idempotency key", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const enqueue = createOnboardingImportTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, { id: "run_abc123" });
      }) as typeof fetch,
    });

    const run = await enqueue("11111111-1111-4111-8111-111111111111", {
      fresh: false,
    });

    expect(run).toEqual({ id: "run_abc123" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.trigger.test/api/v1/tasks/lifty-onboarding-import/trigger",
    );
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tr_prod_test_key");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      payload: { submissionId: "11111111-1111-4111-8111-111111111111" },
      options: {
        idempotencyKey:
          "lifty-onboarding-import:11111111-1111-4111-8111-111111111111",
        idempotencyKeyTTL: "1h",
      },
    });
  });

  it("varies the idempotency key when a failed import needs a fresh run", async () => {
    let body: { options?: { idempotencyKey?: string } } = {};
    const enqueue = createOnboardingImportTrigger({
      ...settings,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(200, { id: "run_retry" });
      }) as typeof fetch,
    });

    await enqueue("11111111-1111-4111-8111-111111111111", { fresh: true });

    expect(body.options?.idempotencyKey).toMatch(
      /^lifty-onboarding-import:11111111-1111-4111-8111-111111111111:retry:\d+$/,
    );
  });

  it.each([
    ["a non-2xx response", async () => jsonResponse(500, { error: "boom" })],
    ["a missing run id", async () => jsonResponse(200, {})],
    [
      "a network failure",
      async () => {
        throw new Error("socket hang up");
      },
    ],
  ])("maps %s to a safe enqueue failure", async (_label, fetchImpl) => {
    const enqueue = createOnboardingImportTrigger({
      ...settings,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      enqueue("11111111-1111-4111-8111-111111111111", { fresh: false }),
    ).rejects.toMatchObject({
      status: 502,
      code: "IMPORT_ENQUEUE_FAILED",
    });
  });
});

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
