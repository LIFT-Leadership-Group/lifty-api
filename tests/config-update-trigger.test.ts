import { describe, expect, it } from "vitest";

import {
  createConfigUpdateTrigger,
  createIntegrationRevocationTrigger,
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

describe("config update trigger client", () => {
  it("enqueues the lifty-config-update task with a submission-scoped idempotency key", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const enqueue = createConfigUpdateTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse(200, { id: "run_cfg" });
      }) as typeof fetch,
    });

    const run = await enqueue("44444444-4444-4444-8444-444444444444", { requeuedAt: null });

    expect(run).toEqual({ id: "run_cfg" });
    expect(requests[0]?.url).toBe(
      "https://api.trigger.test/api/v1/tasks/lifty-config-update/trigger",
    );
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      payload: { submissionId: "44444444-4444-4444-8444-444444444444" },
      options: {
        idempotencyKey: "lifty-config-update:44444444-4444-4444-8444-444444444444",
        idempotencyKeyTTL: "1h",
      },
    });
  });

  it("keys a requeued regeneration on its requeue stamp, deterministically", async () => {
    let body: { options?: { idempotencyKey?: string } } = {};
    const enqueue = createConfigUpdateTrigger({
      ...settings,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(200, { id: "run_retry" });
      }) as typeof fetch,
    });

    await enqueue("44444444-4444-4444-8444-444444444444", {
      requeuedAt: "2026-09-03T06:53:00Z",
    });

    expect(body.options?.idempotencyKey).toBe(
      "lifty-config-update:44444444-4444-4444-8444-444444444444:retry:2026-09-03T06:53:00Z",
    );
  });

  it("enqueues the lifty-integration-revoke task keyed on the revocation row (LIF-681)", async () => {
    let request: { url: string; body: unknown } | null = null;
    const enqueue = createIntegrationRevocationTrigger({
      ...settings,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        request = { url: String(url), body: JSON.parse(String(init?.body)) };
        return jsonResponse(200, { id: "run_revoke" });
      }) as typeof fetch,
    });

    await expect(enqueue("681a0000-0000-4000-a000-000000000001")).resolves.toEqual({
      id: "run_revoke",
    });
    expect(request).toEqual({
      url: "https://api.trigger.test/api/v1/tasks/lifty-integration-revoke/trigger",
      body: {
        payload: { revocationId: "681a0000-0000-4000-a000-000000000001" },
        options: {
          idempotencyKey: "lifty-integration-revoke:681a0000-0000-4000-a000-000000000001",
          idempotencyKeyTTL: "1h",
        },
      },
    });
  });

  it("maps a Trigger.dev failure to the public enqueue error", async () => {
    const enqueue = createConfigUpdateTrigger({
      ...settings,
      fetchImpl: (async () => jsonResponse(500, {})) as typeof fetch,
    });

    await expect(
      enqueue("44444444-4444-4444-8444-444444444444", { requeuedAt: null }),
    ).rejects.toMatchObject({ status: 502, code: "IMPORT_ENQUEUE_FAILED" });
  });
});
