// Generated from lift-gtm-dashboard/lib/crm-shared/executable.ts; regenerate with scripts/sync-crm-contract.mjs.
// Shared pure CRM contract from lift-gtm-jobs (LIF-740/741/742/743).
// Keep behavior aligned; crm-shared-conformance.test.ts runs the jobs fixtures.

import type { CrmFieldMapping, CrmWriteMode } from "./types.js";

const WRITE_RULES = new Set(["create_only", "only_if_empty", "overwrite_lift_field", "managed_enum_transition"]);
export interface MappingFinding { code: "mapping_destination_missing" | "mapping_collision" | "mapping_config_invalid"; mappingIds: string[]; message: string }

export function isExecutableMapping(row: CrmFieldMapping, mode?: CrmWriteMode): boolean {
  return row.enabled && (row.provider === "hubspot" || row.provider === "attio") &&
    Boolean(row.destination_object?.trim() && row.destination_field?.trim()) &&
    WRITE_RULES.has(row.write_rule) && !(mode === "update" && row.write_rule === "create_only") &&
    mappingTransformValid(row);
}

export function mappingTransformValid(row: Pick<CrmFieldMapping, "transform_config" | "source_path" | "value_source" | "write_rule" | "transform">): boolean {
  const c = row.transform_config;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  if (!Array.isArray(row.source_path)) return false;
  if (row.value_source === "constant" && !("constant_value" in c)) return false;
  if (!["path", "constant", "runtime", "counterpart_property"].includes(row.value_source)) return false;
  if (row.write_rule === "managed_enum_transition") {
    const explicitValues = Array.isArray(c.managed_values) && c.managed_values.length > 0 && c.managed_values.every((value) => typeof value === "string");
    const ranked = c.rank && typeof c.rank === "object" && !Array.isArray(c.rank) &&
      Object.values(c.rank).length > 0 && Object.values(c.rank).every((value) => typeof value === "number" && Number.isFinite(value)) &&
      c.aliases && typeof c.aliases === "object" && !Array.isArray(c.aliases) &&
      Object.values(c.aliases).every((value) => Array.isArray(value) && value.every((alias) => typeof alias === "string"));
    if (!explicitValues && !ranked) return false;
  }
  switch (row.transform) {
    case "none": case "json_string": case "normalize_domain": return true;
    case "map_value": return Boolean(c.map && typeof c.map === "object" && !Array.isArray(c.map));
    case "bucket": return Array.isArray(c.buckets) && c.buckets.length > 0 && c.buckets.every((b) => b && typeof b === "object" && (typeof (b as Record<string, unknown>).label === "string" || typeof (b as Record<string, unknown>).to === "string"));
    case "scale_number": return c.scale === undefined || (typeof c.scale === "number" && Number.isFinite(c.scale));
    case "join_list": return (c.separator === undefined || typeof c.separator === "string") && (c.join_separator === undefined || typeof c.join_separator === "string");
    default: return false;
  }
}

export function mappingCollisionKey(row: CrmFieldMapping): string {
  return JSON.stringify([row.workspace_id, row.provider, row.source_stage, row.destination_object, row.destination_field]);
}

function managedTransitionPolicyKey(config: CrmFieldMapping["transform_config"]): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  };
  return JSON.stringify(stable({managed_values: config.managed_values, rank: config.rank, aliases: config.aliases}));
}

export function validFallbackGroup(rows: Pick<CrmFieldMapping, "fallback_group" | "fallback_priority" | "write_rule" | "transform_config">[]): boolean {
  const group = rows[0]?.fallback_group;
  return typeof group === "string" && group.trim().length > 0 && rows.every((row) =>
    row.fallback_group === group && Number.isInteger(row.fallback_priority) &&
    (row.fallback_priority as number) >= 0 && row.write_rule === rows[0]!.write_rule &&
    (row.write_rule !== "managed_enum_transition" || managedTransitionPolicyKey(row.transform_config) === managedTransitionPolicyKey(rows[0]!.transform_config))) &&
    new Set(rows.map((row) => row.fallback_priority)).size === rows.length;
}

export function inspectExecutableMappings(mappings: CrmFieldMapping[]): MappingFinding[] {
  const findings: MappingFinding[] = [];
  const destinations = new Map<string, CrmFieldMapping[]>();
  for (const row of mappings) {
    if (!row.enabled) continue;
    if (!row.destination_object?.trim() || !row.destination_field?.trim()) {
      findings.push({ code: "mapping_destination_missing", mappingIds: [row.id], message: "Executable mappings require a destination object and field" });
      continue;
    }
    if (!isExecutableMapping(row)) {
      findings.push({ code: "mapping_config_invalid", mappingIds: [row.id], message: "Mapping has invalid provider, write rule, or transform configuration" });
      continue;
    }
    if ((row.fallback_group != null || row.fallback_priority != null) && !validFallbackGroup([row])) {
      findings.push({ code: "mapping_collision", mappingIds: [row.id], message: "Fallback requires a non-empty group and non-negative integer priority" });
    }
    const key = mappingCollisionKey(row);
    const group = destinations.get(key) ?? [];
    group.push(row); destinations.set(key, group);
  }
  for (const rows of destinations.values()) {
    if (rows.length > 1 && !validFallbackGroup(rows)) findings.push({ code: "mapping_collision", mappingIds: rows.map((r) => r.id), message: "Same-stage CRM destination requires one ordered fallback group with compatible write rules" });
  }
  return findings;
}
