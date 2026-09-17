import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AuthSession } from "../src/app.js";
import { createCrmMapping } from "../src/crm-mapping.js";
import { MappingError } from "../src/crm-mapping/contracts.js";
import { runCrmMapping } from "../src/crm-mapping/runtime.js";
vi.mock("../src/crm-mapping/runtime.js", () => ({ runCrmMapping: vi.fn() }));
const workspaceRef = "22222222-2222-4222-8222-222222222222";
const session: AuthSession = { userId: workspaceRef, client: {} };
const settings = { serverKey: "dedicated-fixture-key" };
const request = { workspace_ref: workspaceRef, integration_ref: workspaceRef, portal_id: "123", mapping_version: "a".repeat(64), lead_refs: [workspaceRef], preview_digest: "b".repeat(64), request_ref: workspaceRef };
function app() {
  return createApp({ authenticate: async () => ({ ok: true, session }), log: () => {},
    getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: workspaceRef, name: "Example" }, next_action: null }),
    runCrmMapping: createCrmMapping(settings),
  });
}
const send = () => app().request("/v1/workspace/crm/mapping/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
beforeEach(() => { vi.mocked(runCrmMapping).mockReset(); });

describe("public CRM operation boundary", () => {
  it.each([["STALE_PREVIEW", 409], ["MAINTENANCE_READ_ONLY", 503], ["CRM_MAPPING_TIMEOUT", 504], ["HUBSPOT_RATE_LIMITED", 429]])("preserves safe %s semantics at HTTP ingress", async (code, status) => {
    vi.mocked(runCrmMapping).mockRejectedValue(new MappingError(String(code), Number(status)));
    const response = await send();
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("returns bounded repair issues and forwards current workspace cancellation", async () => {
    const issue = { code: "INVALID_MAPPING_EDIT", path: "/edits", message: "Destination conflict.", suggestion: "Refresh the catalog." };
    vi.mocked(runCrmMapping).mockRejectedValue(new MappingError("INVALID_MAPPING_EDIT", 422, [issue]));
    const response = await send();
    expect(response.status).toBe(422);
    expect((await response.json()).error.issues).toEqual([issue]);
    expect(runCrmMapping).toHaveBeenCalledWith(session, settings, "sync", request, { workspaceRef, signal: expect.any(AbortSignal) });
  });

  it.each([new Error("private-token=secret-fixture"), new MappingError("private-token=secret-fixture", 409), new MappingError("STALE_PREVIEW", 200)])("sanitizes unexpected failures", async error => {
    vi.mocked(runCrmMapping).mockRejectedValue(error);
    const response = await send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-fixture");
  });

  it("drops malformed repair details and rejects invalid successful responses", async () => {
    vi.mocked(runCrmMapping).mockRejectedValue(new MappingError("STALE_PREVIEW", 409, [{ code: "STALE_PREVIEW", path: "/", message: "x".repeat(601), suggestion: "Refresh." }]));
    expect((await (await send()).json()).error.issues).toEqual([]);
    vi.mocked(runCrmMapping).mockResolvedValue({ status: "succeeded", run_ref: "invalid-uuid", workspace_ref: workspaceRef, result: { token: "secret-fixture" } });
    const response = await send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-fixture");
  });

  it("fails closed without configured capability and never invokes storage", async () => {
    await expect(createCrmMapping(null)(session, "catalog")).rejects.toMatchObject({ code: "CRM_MAPPING_NOT_CONFIGURED", status: 503 });
    expect(runCrmMapping).not.toHaveBeenCalled();
  });
});
