import { describe, expect, it } from "vitest";

import { createOnboardingImportTrigger } from "../src/trigger-client.js";

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
