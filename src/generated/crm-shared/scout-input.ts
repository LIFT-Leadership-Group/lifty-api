// Generated from lift-gtm-dashboard/lib/crm-shared/scout-input.ts; regenerate with scripts/sync-crm-contract.mjs.
import type { CrmFieldMapping } from "./types.js";

export type ScoutContractField = Pick<CrmFieldMapping,
  "source_stage" | "source_entity" | "source_field" | "source_path" | "label" |
  "transform_config" | "enabled" | "required_from_agent"> & Partial<Pick<CrmFieldMapping, "transform" | "write_rule" | "value_source">>;

/** Browser-safe counterpart of the jobs Scout input contract boundary. */
export function scoutInputFields(input: unknown): ScoutContractField[] {
  if (input == null) return [];
  const fail = () => { throw new Error("Invalid version 1 Scout input contract"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const contract = input as Record<string, unknown>;
  if (contract.version !== 1 || !Array.isArray(contract.fields) || Object.keys(contract).some((key) => key !== "version" && key !== "fields")) return fail();
  for (const field of contract.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) return fail();
    if (!["discovery", "research", "outreach", "verification"].includes(field.source_stage) || !["lead", "company"].includes(field.source_entity) || typeof field.source_field !== "string" || !field.source_field || !Array.isArray(field.source_path) || !field.source_path.length || field.source_path.some((part: unknown) => typeof part !== "string" || !part) || !(field.label === null || typeof field.label === "string") || !field.transform_config || typeof field.transform_config !== "object" || Array.isArray(field.transform_config) || typeof field.enabled !== "boolean" || typeof field.required_from_agent !== "boolean") return fail();
  }
  return contract.fields as ScoutContractField[];
}
