import { expect, it, vi } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { createCompanyMapping, CompanyMappingError } from "../src/company-mapping.js";
const ws = "85400000-0000-4000-a000-000000000001";
const receipt = {
  status: "ready" as const,
  workspace_ref: ws,
  portal_id: "123",
  mapping_count: 5 as const,
  schema_changes: 3,
  verified: true as const,
};
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

it("fails explicitly when the dedicated CRM capability is not configured", async () => {
  await expect(createCompanyMapping(null)({userId:ws,client:{}},"context")).rejects.toMatchObject({code:"COMPANY_MAPPING_NOT_CONFIGURED",status:503});
});
it("passes only a valid explicit workspace and cancellation to native company workflow", async () => {
 const operation=vi.fn().mockResolvedValue({version:1,workspace_ref:ws,workspace_name:"Fixture",portal_id:"123",integration_ref:ws,mapping_version:"a".repeat(64),schema_version:"b".repeat(64),status:"action_needed",properties:[],mappings:[],configured_values:null,issues:[],instructions:"Choose",input_schema:{}});
 const app=createApp({authenticate:async()=>({ok:true,session:{userId:ws,client:{}}}),companyMapping:operation});
 const path="/v1/integrations/hubspot/company-mapping/context";
 expect((await app.request(`${path}?workspace_ref=${ws}`,{headers:{authorization:"Bearer fixture"}})).status).toBe(200);
 expect(operation.mock.calls[0]?.[3]).toMatchObject({workspaceRef:ws});
 operation.mockClear();
 expect((await app.request(`${path}?workspace_ref=invalid`,{headers:{authorization:"Bearer fixture"}})).status).toBe(400);
 expect(operation).not.toHaveBeenCalled();
});
