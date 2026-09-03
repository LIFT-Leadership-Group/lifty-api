import { describe, expect, it } from "vitest";

import { createConfigUpdateTrigger } from "../src/trigger-client.js";

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

    const run = await enqueue("44444444-4444-4444-8444-444444444444", { fresh: false });

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

  it("varies the idempotency key when a failed regeneration needs a fresh run", async () => {
    let body: { options?: { idempotencyKey?: string } } = {};
    const enqueue = createConfigUpdateTrigger({
      ...settings,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(200, { id: "run_retry" });
      }) as typeof fetch,
    });

    await enqueue("44444444-4444-4444-8444-444444444444", { fresh: true });

    expect(body.options?.idempotencyKey).toMatch(
      /^lifty-config-update:44444444-4444-4444-8444-444444444444:retry:\d+$/,
    );
  });

  it("maps a Trigger.dev failure to the public enqueue error", async () => {
    const enqueue = createConfigUpdateTrigger({
      ...settings,
      fetchImpl: (async () => jsonResponse(500, {})) as typeof fetch,
    });

    await expect(
      enqueue("44444444-4444-4444-8444-444444444444", { fresh: false }),
    ).rejects.toMatchObject({ status: 502, code: "IMPORT_ENQUEUE_FAILED" });
  });
});
