import {
  checkExistingMappings,
  configuredValues,
  desiredMappings,
  FIELDS,
  fingerprint,
  inputSchema,
  instructions,
  type Mapping,
  MappingError,
  parsePlan,
  type Plan,
  type Property,
  schemaChanges,
  type State,
} from "./contract.js";

export interface MappingTools {
  state(): Promise<State>;
  properties(state: State): Promise<Property[]>;
  createProperty(state: State, property: Property): Promise<void>;
  addOptions(state: State, property: Property): Promise<void>;
  publish(state: State, mappings: Mapping[]): Promise<void>;
}
export async function schemaVersion(properties: Property[]): Promise<string> {
  return await fingerprint(
    properties.filter((p) => FIELDS.includes(p.name as typeof FIELDS[number]))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}
function assertScope(state: State, plan: Plan): void {
  if (
    state.workspace_ref !== plan.workspace_ref ||
    state.portal_id !== plan.portal_id
  ) throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
}
export async function companyMappingContext(tools: MappingTools) {
  const state = await tools.state();
  const properties = await tools.properties(state);
  const values = configuredValues(state);
  let ready = false;
  let issues: MappingError["issues"] = [];
  if (values) {
    try {
      const desired = desiredMappings(values);
      checkExistingMappings(state, desired);
      ready = desired.every((m) =>
        state.mappings.some((r) =>
          r.source_stage === m.source_stage &&
          r.destination_field === m.destination_field
        )
      ) && schemaChanges(properties, values).length === 0;
    } catch (error) {
      if (error instanceof MappingError) issues = error.issues;
      else throw error;
    }
  }
  return {
    version: 1,
    ...state,
    schema_version: await schemaVersion(properties),
    status: ready ? "ready" : "action_needed",
    properties,
    configured_values: values,
    issues,
    instructions,
    input_schema: inputSchema,
  };
}
export async function applyCompanyMapping(input: unknown, tools: MappingTools) {
  const plan = parsePlan(input);
  const state = await tools.state();
  assertScope(state, plan);
  const desired = desiredMappings(plan);
  checkExistingMappings(state, desired);
  const properties = await tools.properties(state);
  const changes = schemaChanges(properties, plan);
  const allMapped = desired.every((m) =>
    state.mappings.some((r) =>
      r.source_stage === m.source_stage &&
      r.destination_field === m.destination_field
    )
  );
  // An exact successful retry is a fresh readback, with no repeated writes.
  if (allMapped && changes.length === 0) {
    return {
      status: "ready",
      workspace_ref: state.workspace_ref,
      portal_id: state.portal_id,
      mapping_count: 5,
      schema_changes: 0,
      verified: true,
    };
  }
  if (
    state.mapping_version !== plan.mapping_version ||
    await schemaVersion(properties) !== plan.schema_version
  ) {
    throw new MappingError("STALE_CONTEXT", 409, [{
      code: "STALE_CONTEXT",
      path: "/",
      message: "The portal schema or workspace mappings changed.",
      suggestion:
        "Fetch fresh company-mapping context and regenerate the complete plan.",
    }]);
  }
  if (changes.length && !plan.allow_schema_changes) {
    throw new MappingError("SCHEMA_CHANGES_REQUIRED", 409, [{
      code: "SCHEMA_CHANGES_REQUIRED",
      path: "/allow_schema_changes",
      message: "This plan requires additive company property changes.",
      suggestion:
        "Obtain authorization to configure company properties, then submit the reviewed plan with allow_schema_changes=true.",
    }]);
  }
  for (const change of changes) {
    const freshState = await tools.state();
    assertScope(freshState, plan);
    if (
      freshState.integration_ref !== state.integration_ref ||
      freshState.mapping_version !== state.mapping_version
    ) throw new MappingError("STALE_CONTEXT", 409);
    // Re-read immediately before each write; preserve all currently present options.
    const liveProperties = await tools.properties(freshState);
    const current = schemaChanges(liveProperties, plan).find((c) =>
      c.field === change.field
    );
    if (!current) continue;
    if (current.action === "create") {
      await tools.createProperty(freshState, current.property);
    } else await tools.addOptions(freshState, current.property);
  }
  if (schemaChanges(await tools.properties(state), plan).length !== 0) {
    throw new MappingError("PROPERTY_READBACK_FAILED", 502);
  }
  await tools.publish(state, desired);
  const after = await tools.state();
  assertScope(after, plan);
  checkExistingMappings(after, desired);
  if (
    !desired.every((m) =>
      after.mappings.some((r) =>
        r.source_stage === m.source_stage &&
        r.destination_field === m.destination_field
      )
    ) || schemaChanges(await tools.properties(after), plan).length
  ) throw new MappingError("MAPPING_READBACK_FAILED", 502);
  return {
    status: "ready",
    workspace_ref: after.workspace_ref,
    portal_id: after.portal_id,
    mapping_count: 5,
    schema_changes: changes.length,
    verified: true,
  };
}
