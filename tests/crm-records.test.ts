import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { fixture, ws, runRef } from "./crm-mapping-fixture.js";
import { CrmRecordsSchema } from "../src/crm-records.js";
describe("CRM record links", () => {
  it("advertises authenticated read-only exact cohort links", async () => {
    const context = await (
      await createApp().request(
        "/v1/context/crm?client_contract=lifty-cli-context.v5",
      )
    ).json();
    expect(context.operations.records).toMatchObject({
      method: "GET",
      route: "/v1/workspace/crm/records",
    });
    expect(
      (await createApp().request("/v1/workspace/crm/records")).status,
    ).toBe(401);
  });
  it("returns verified links through current-workspace route without starting sync", async () => {
    const f = fixture(),
      sync = vi.fn();
    const app = createApp({
      authenticate: async () => ({ ok: true, session: f.session }),
      log: () => {},
      getWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: { workspace_ref: ws, name: "Example" },
        next_action: null,
      }),
      runCrmMapping: (_s, a, i) => f.run(a, i),
      startCrmSyncRun: sync,
    });
    const response = await app.request(
      `/v1/workspace/crm/records?run_ref=${runRef}`,
      {
        headers: {
          authorization: "Bearer founder",
          "x-lifty-client-contract": "lifty-cli-context.v5",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = CrmRecordsSchema.parse(await response.json());
    expect(data).toMatchObject({
      leads: [
        {
          name: "Abraham Jankans",
          contact_url:
            "https://app.hubspot.com/contacts/52044090/record/0-1/123456789",
          company_url:
            "https://app.hubspot.com/contacts/52044090/record/0-2/987654321",
          contact_status: "verified",
          company_status: "verified",
        },
      ],
    });
    expect(
      f.rpc.mock.calls.find(([, a]) => a.p_operation === "records")?.[1]
        .p_payload.run_ref,
    ).toBe(runRef);
    expect(sync).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("never builds a link using a mismatched target identity", async () => {
    const f = fixture();
    f.records.contact.email = "other@example.com";
    expect(await f.run("records", {})).toMatchObject({
      leads: [{ contact_url: null, contact_status: "identity_mismatch" }],
    });
  });
  it("keeps absent or malformed pointers unlinked", async () => {
    const f = fixture();
    f.lead.crm_contact_id = "../wrong";
    f.lead.crm_company_id = null;
    expect(await f.run("records", {})).toMatchObject({
      leads: [
        {
          contact_url: null,
          company_url: null,
          contact_status: "missing_record",
          company_status: "missing_record",
        },
      ],
    });
    expect(f.provider).not.toHaveBeenCalled();
  });
});
