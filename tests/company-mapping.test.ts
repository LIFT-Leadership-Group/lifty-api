import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { companyMapping, CompanyMappingError } from "../src/company-mapping.js";
const ws = "85400000-0000-4000-a000-000000000001";
const receipt = {
  status: "ready" as const,
  workspace_ref: ws,
  portal_id: "123",
  mapping_count: 5 as const,
  schema_changes: 3,
  verified: true as const,
};
it("forwards a bounded plan only through the caller's Edge client and validates readback", async () => {
  const invoke = vi.fn().mockResolvedValue({
    data: { data: receipt },
    error: null,
  });
  const session = { userId: ws, client: { functions: { invoke } } };
  expect(await companyMapping(session, "apply", { version: 1 })).toEqual(
    receipt,
  );
  expect(invoke).toHaveBeenCalledWith("lifty-company-mapping", {
    body: { action: "apply", plan: { version: 1 } },
  });
  invoke.mockResolvedValue({
    data: { data: { ...receipt, verified: false } },
    error: null,
  });
  await expect(companyMapping(session, "apply", {})).rejects.toMatchObject({
    code: "INVALID_COMPANY_MAPPING_RESPONSE",
  });
});
it("keeps provider/transport errors private and forwards only bounded repair diagnostics", async () => {
  const issue = {
    code: "SCHEMA_CONFLICT",
    path: "/properties/type",
    message: "Incompatible field.",
    suggestion: "Review its meaning.",
  };
  const invoke = vi.fn().mockResolvedValue({
    error: {
      context: new Response(
        JSON.stringify({
          error: {
            code: "SCHEMA_CONFLICT",
            message: "private provider error",
            issues: [issue],
          },
        }),
        { status: 409 },
      ),
    },
  });
  await expect(
    companyMapping(
      { userId: ws, client: { functions: { invoke } } },
      "apply",
      {},
    ),
  ).rejects.toMatchObject({ code: "SCHEMA_CONFLICT", issues: [issue] });
  invoke.mockResolvedValue({ error: new Error("private credential") });
  await expect(
    companyMapping(
      { userId: ws, client: { functions: { invoke } } },
      "context",
    ),
  ).rejects.toMatchObject({ code: "COMPANY_MAPPING_UNAVAILABLE" });
});
it("routes require authentication, reject oversized plans and surface repair issues", async () => {
  const operation = vi.fn().mockResolvedValue(receipt);
  const app = createApp({
    authenticate: async () => ({
      ok: true,
      session: { userId: ws, client: {} },
    }),
    companyMapping: operation,
  });
  const url = "/v1/integrations/hubspot/company-mapping";
  const response = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer fixture" },
    body: JSON.stringify({ version: 1 }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
  operation.mockClear();
  expect(
    (await app.request(url, {
      method: "POST",
      headers: { authorization: "Bearer fixture" },
      body: "x".repeat(17000),
    })).status,
  ).toBe(413);
  expect(operation).not.toHaveBeenCalled();
  const issue = {
    code: "STALE_CONTEXT",
    path: "/",
    message: "Changed.",
    suggestion: "Regenerate.",
  };
  operation.mockRejectedValue(
    new CompanyMappingError("STALE_CONTEXT", 409, [issue]),
  );
  const rejected = await app.request(url, {
    method: "POST",
    headers: { authorization: "Bearer fixture" },
    body: "{}",
  });
  expect((await rejected.json()).error.issues).toEqual([issue]);
  expect(
    (await createApp().request(url, { method: "POST", body: "{}" })).status,
  ).toBe(401);
});
