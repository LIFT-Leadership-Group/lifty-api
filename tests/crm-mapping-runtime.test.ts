import { describe, it, expect } from "vitest";
import { fixture, leadRef, runRef } from "./crm-mapping-fixture.js";
import * as C from "../src/crm-mapping/contracts.js";
import { runCrmMapping } from "../src/crm-mapping/runtime.js";
describe("scoped CRM mapping runtime", () => {
  it("exposes full property catalog including native Industry without credentials", async () => {
    const f = fixture();
    const catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    expect(catalog.properties.company.some((p) => p.name === "industry")).toBe(
      true,
    );
    expect(catalog.sources.discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "person_city" }),
        expect.objectContaining({ column: "industry" }),
      ]),
    );
    expect(JSON.stringify(catalog)).not.toMatch(
      /scoped-access|fixture-only|capability-key/,
    );
  });
  it("keeps personal and company locations separate with saved evidence", async () => {
    const f = fixture();
    expect(await f.run("sources", { lead_refs: [leadRef] })).toMatchObject({
      leads: [
        {
          discovery: { person_city: null },
          company_research: { headquarters_city: "Buenos Aires" },
        },
      ],
    });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("previews and schedules exactly the selected applied revision; retries reuse receipt", async () => {
    const f = fixture();
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    const request = {
      ...f.scope(),
      lead_refs: [leadRef],
      preview_digest: preview.preview_digest,
      request_ref: runRef,
    };
    expect(await f.run("sync", request)).toMatchObject({
      status: "queued",
      run_ref: runRef,
    });
    expect(f.enqueue).toHaveBeenCalledWith(runRef, f.state.workspace_ref);
    const calls = f.provider.mock.calls.length;
    f.records.company.industry = "COMPUTER_SOFTWARE";
    expect(await f.run("sync", request)).toMatchObject({ run_ref: runRef });
    expect(f.provider.mock.calls).toHaveLength(calls);
    expect(
      f.rpc.mock.calls.filter(([, a]) => a.p_operation === "sync"),
    ).toHaveLength(1);
    expect(f.writes).toEqual([]);
  });
  it("rejects changed CRM values between preview and scheduling", async () => {
    const f = fixture();
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    f.records.company.industry = "OTHER";
    await expect(
      f.run("sync", {
        ...f.scope(),
        lead_refs: [leadRef],
        preview_digest: preview.preview_digest,
        request_ref: runRef,
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("cannot schedule an empty preview as successful updates", async () => {
    const f = fixture();
    f.lead.discovery.industry = null;
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    await expect(
      f.run("sync", {
        ...f.scope(),
        lead_refs: [leadRef],
        preview_digest: preview.preview_digest,
        request_ref: runRef,
      }),
    ).rejects.toMatchObject({ code: "NO_FIELDS_TO_APPLY" });
  });
  it("applies general mapping edits through shared validator and atomic capability", async () => {
    const f = fixture();
    const catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    const { created_at: _c, updated_at, id, ...values } = f.state.mappings[0]!;
    const edit = {
      ...values,
      id,
      expected_updated_at: updated_at,
      write_rule: "overwrite_lift_field",
    };
    expect(
      await f.run("apply", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        edits: [edit],
      }),
    ).toMatchObject({ state: "applied", mapping_version: "b".repeat(64) });
    expect(
      f.rpc.mock.calls.find(([, a]) => a.p_operation === "apply")?.[1].p_payload
        .updates,
    ).toMatchObject([
      {
        id,
        expected_updated_at: updated_at,
        values: { write_rule: "overwrite_lift_field" },
      },
    ]);
    expect(f.writes).toEqual([]);
  });
  it("rejects stale per-row edits and leaves unrelated mappings intact", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    const { created_at: _c, updated_at: _u, ...values } = f.state.mappings[0]!;
    await expect(
      f.run("apply", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        edits: [{ ...values, expected_updated_at: "old" }],
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    expect(f.rpc.mock.calls.some(([, a]) => a.p_operation === "apply")).toBe(
      false,
    );
  });
  it("creates a property only through explicit permission and verified schema", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    const request = {
      ...f.scope(),
      schema_version: catalog.schema_version,
      object: "contact",
      property: {
        name: "lifty_test",
        label: "Lifty Test",
        groupName: "contactinformation",
        type: "string",
        fieldType: "text",
      },
    };
    f.state.allow_provisioning = false;
    await expect(f.run("property_create", request)).rejects.toMatchObject({
      code: "HUBSPOT_PROVISIONING_DISABLED",
    });
    expect(f.writes).toEqual([]);
    f.state.allow_provisioning = true;
    expect(await f.run("property_create", request)).toMatchObject({
      state: "created",
      property: { name: "lifty_test" },
    });
    expect(f.writes).toEqual(["lifty_test"]);
  });
  it("finds existing Industry before creating a duplicate property", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    await expect(
      f.run("property_create", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        object: "company",
        property: {
          name: "industry_new",
          label: "Industry",
          groupName: "companyinformation",
          type: "string",
          fieldType: "text",
        },
      }),
    ).rejects.toMatchObject({ code: "HUBSPOT_PROPERTY_ALREADY_EXISTS" });
    expect(f.writes).toEqual([]);
  });
  it("denies mismatched provider portals before property or record access", async () => {
    const f = fixture();
    f.provider.mockResolvedValue(Response.json({ portalId: 999 }));
    await expect(f.run("catalog")).rejects.toMatchObject({
      code: "WORKSPACE_OR_PORTAL_CHANGED",
    });
    expect(f.writes).toEqual([]);
  });
  it("maintenance blocks all mutations before storage/provider work", async () => {
    const f = fixture();
    for (const action of ["apply", "sync", "property_create"] as const)
      await expect(
        runCrmMapping(f.session, { ...f.settings, readOnly: true }, action, {}),
      ).rejects.toMatchObject({ code: "MAINTENANCE_READ_ONLY" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("safely strips unknown storage failure details", async () => {
    const f = fixture();
    f.rpc.mockRejectedValue(new Error("fixture-only-secret"));
    await expect(f.run("catalog")).rejects.toMatchObject({
      code: "CRM_MAPPING_UNAVAILABLE",
    });
  });
});
