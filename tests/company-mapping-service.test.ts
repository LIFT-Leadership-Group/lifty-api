import { it } from "vitest";
import assert from "node:assert/strict";
import {
  desiredMappings,
  MappingError,
  parsePlan,
  type Plan,
  type Property,
  type State,
} from "../src/company-mapping/contract.js";
import {
  applyCompanyMapping,
  companyMappingContext,
  type MappingTools,
  schemaVersion,
} from "../src/company-mapping/service.js";
const ws = "85400000-0000-4000-a000-000000000001";
const values = {
  type_values: { top_target: "Top Target", prospect: "PROSPECT" },
  tier_values: { A: "A", B: "B", C: "C", "Non-ICP": "Non-ICP" },
};
function fixture() {
  const state: State = {
    workspace_ref: ws,
    workspace_name: "Fixture",
    portal_id: "123",
    integration_ref: "85400000-0000-4000-a000-000000000002",
    mapping_version: "a".repeat(64),
    mappings: [],
  };
  const properties: Property[] = [
    { name: "name", label: "Name", type: "string", fieldType: "text" },
    { name: "domain", label: "Domain", type: "string", fieldType: "text" },
    {
      name: "type",
      label: "Type",
      type: "enumeration",
      fieldType: "select",
      options: [{ label: "Prospect", value: "PROSPECT" }, {
        label: "Customer-owned",
        value: "CUSTOMER",
        hidden: true,
        displayOrder: 9,
      }],
    },
  ];
  const writes: string[] = [];
  const tools: MappingTools = {
    state: async () => structuredClone(state),
    properties: async () => structuredClone(properties),
    createProperty: async (_, property) => {
      writes.push(`create:${property.name}`);
      properties.push(structuredClone(property));
    },
    addOptions: async (_, property) => {
      writes.push(`options:${property.name}`);
      properties[properties.findIndex((p) => p.name === property.name)] =
        structuredClone(property);
    },
    publish: async (_, mappings) => {
      writes.push("publish");
      state.mappings = structuredClone(mappings);
      state.mapping_version = "b".repeat(64);
    },
  };
  const plan = async (): Promise<Plan> => ({
    version: 1,
    workspace_ref: ws,
    portal_id: "123",
    mapping_version: state.mapping_version,
    schema_version: await schemaVersion(properties),
    ...values,
    allow_schema_changes: true,
  });
  return { state, properties, writes, tools, plan };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof MappingError && error.code === expected;
it("local context → provision → atomic mapping publication → ready readback and exact retry", async () => {
  const f = fixture();
  assert.equal((await companyMappingContext(f.tools)).status, "action_needed");
  assert.deepEqual(f.writes, []);
  const plan = await f.plan();
  const receipt = await applyCompanyMapping(plan, f.tools);
  assert.equal(receipt.verified, true);
  assert.equal(f.state.mappings.length, 5);
  assert.equal((await companyMappingContext(f.tools)).status, "ready");
  assert.equal(
    f.properties.find((p) => p.name === "type")?.options?.find((o) =>
      o.value === "CUSTOMER"
    )?.hidden,
    true,
  );
  const writes = [...f.writes];
  await applyCompanyMapping(plan, f.tools);
  assert.deepEqual(f.writes, writes);
});
it("wrong workspace/portal and stale schema/config do not write", async () => {
  for (const mutation of ["workspace", "portal", "schema", "mapping"]) {
    const f = fixture(), plan = await f.plan();
    if (mutation === "workspace") {
      plan.workspace_ref = "85400000-0000-4000-a000-000000000099";
    }
    if (mutation === "portal") plan.portal_id = "999";
    if (mutation === "schema") f.properties[0]!.label = "Changed by operator";
    if (mutation === "mapping") f.state.mapping_version = "c".repeat(64);
    await assert.rejects(
      applyCompanyMapping(plan, f.tools),
      code(
        ["schema", "mapping"].includes(mutation)
          ? "STALE_CONTEXT"
          : "WORKSPACE_OR_PORTAL_CHANGED",
      ),
    );
    assert.deepEqual(f.writes, []);
  }
});
it("invalid complete plan rejects extra destinations and malformed tier choices", async () => {
  const plan = await fixture().plan();
  for (
    const value of [{ ...plan, delete_property: true }, {
      ...plan,
      tier_values: { A: "A" },
    }, {
      ...plan,
      type_values: { top_target: "PROSPECT", prospect: "PROSPECT" },
    }, { ...plan, tier_values: { ...plan.tier_values, A: "one;two" } }]
  ) assert.throws(() => parsePlan(value), code("INVALID_PLAN"));
});
it("disabled, changed and duplicate operator mappings are preserved", async () => {
  for (const mode of ["disabled", "changed", "duplicate"]) {
    const f = fixture();
    const existing = desiredMappings(values)[0]!;
    f.state.mappings = mode === "duplicate" ? [existing, existing] : [{
      ...existing,
      ...(mode === "disabled"
        ? { enabled: false }
        : { write_rule: "only_if_empty" }),
    }];
    await assert.rejects(
      applyCompanyMapping(await f.plan(), f.tools),
      code("MAPPING_CONFLICT"),
    );
    assert.deepEqual(f.writes, []);
  }
});
it("preflight checks every property before the first mutation", async () => {
  const f = fixture();
  f.properties.push({
    name: "icp_tier",
    label: "Other semantics",
    type: "number",
    fieldType: "number",
  });
  await assert.rejects(
    applyCompanyMapping(await f.plan(), f.tools),
    code("SCHEMA_CONFLICT"),
  );
  assert.deepEqual(f.writes, []);
});
it("no unapproved additions and no use of read-only/hidden options", async () => {
  const f = fixture();
  await assert.rejects(
    applyCompanyMapping(
      { ...await f.plan(), allow_schema_changes: false },
      f.tools,
    ),
    code("SCHEMA_CHANGES_REQUIRED"),
  );
  f.properties[2]!.modificationMetadata = { readOnlyOptions: true };
  await assert.rejects(
    applyCompanyMapping(await f.plan(), f.tools),
    code("SCHEMA_CONFLICT"),
  );
  assert.deepEqual(f.writes, []);
});
it("partial provider failure publishes no mappings and fresh-context retry converges", async () => {
  const f = fixture();
  const original = f.tools.createProperty;
  f.tools.createProperty = async (state, property) => {
    if (property.name === "enrichment_source") {
      throw new MappingError("HUBSPOT_RATE_LIMITED", 429);
    }
    await original(state, property);
  };
  const plan = await f.plan();
  await assert.rejects(
    applyCompanyMapping(plan, f.tools),
    code("HUBSPOT_RATE_LIMITED"),
  );
  assert.equal(f.state.mappings.length, 0);
  assert.equal(f.properties.filter((p) => p.name === "icp_tier").length, 1);
  await assert.rejects(
    applyCompanyMapping(plan, f.tools),
    code("STALE_CONTEXT"),
  );
  f.tools.createProperty = original;
  await applyCompanyMapping(await f.plan(), f.tools);
  assert.equal(f.properties.filter((p) => p.name === "icp_tier").length, 1);
  assert.equal((await companyMappingContext(f.tools)).status, "ready");
});
it("provider accepted-but-not-readable never publishes", async () => {
  const f = fixture();
  f.tools.createProperty = async () => {};
  await assert.rejects(
    applyCompanyMapping(await f.plan(), f.tools),
    code("PROPERTY_READBACK_FAILED"),
  );
  assert.equal(f.writes.includes("publish"), false);
});
it("connection changed mid-flight cannot publish or mutate another portal", async () => {
  const f = fixture();
  const original = f.tools.addOptions;
  f.tools.addOptions = async (state, property) => {
    await original(state, property);
    f.state.portal_id = "999";
  };
  await assert.rejects(
    applyCompanyMapping(await f.plan(), f.tools),
    code("WORKSPACE_OR_PORTAL_CHANGED"),
  );
  assert.deepEqual(f.writes, ["options:type"]);
});
