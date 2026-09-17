// Generated from lift-gtm-dashboard/lib/crm-shared/scout-contract.ts; regenerate with scripts/sync-crm-contract.mjs.
// Shared pure CRM contract from lift-gtm-jobs (LIF-740/741/742/743).
// Keep behavior aligned; crm-shared-conformance.test.ts runs the jobs fixtures.

import type { ScoutContractField } from "./scout-input.js";
import { sha256Hex } from "./sha256.js";
import type { CrmFieldMapping, JsonObject } from "./types.js";

export interface CanonicalizeScoutContractInput {
  baseSchema: unknown | null | undefined;
  schemaName: string;
  contractText: string | null | undefined;
  mappings: ScoutContractField[];
}

export interface CanonicalScoutContract {
  canonical: JsonObject;
  hash: string;
}

interface CanonicalMappingExtension {
  source_path: string[];
  required_from_agent: boolean;
  enabled: boolean;
  source_stage: CrmFieldMapping["source_stage"];
  source_type: string | null;
  label: string | null;
}

/**
 * Builds the immutable identity of the effective Scout output contract.
 * CRM destinations and write behavior are deliberately absent: changing where
 * a value is written must not mint a new agent-output contract version.
 */
export function canonicalizeScoutContract(
  input: CanonicalizeScoutContractInput,
): CanonicalScoutContract {
  const extensions = effectiveMappingExtensions(input.mappings);
  const canonical = sortObjectKeys({
    schema_name: input.schemaName,
    schema_json: toJsonValue(input.baseSchema ?? null),
    contract_text: input.contractText ?? null,
    mapping_extension: extensions,
  }) as JsonObject;
  const hash = sha256Hex(JSON.stringify(canonical));

  return { canonical, hash };
}

export function hasScoutContractExtension(
  mappings: ScoutContractField[],
): boolean {
  return mappings.some(isScoutContractMapping);
}

function effectiveMappingExtensions(
  mappings: ScoutContractField[],
): CanonicalMappingExtension[] {
  const unique = new Map<string, CanonicalMappingExtension>();

  for (const mapping of mappings) {
    if (!isScoutContractMapping(mapping)) continue;
    const extension: CanonicalMappingExtension = {
      source_path: [...mapping.source_path],
      required_from_agent: mapping.required_from_agent,
      enabled: mapping.enabled,
      source_stage: mapping.source_stage,
      source_type:
        typeof mapping.transform_config.source_type === "string"
          ? mapping.transform_config.source_type
          : null,
      label: mapping.label,
    };
    const key = JSON.stringify(sortObjectKeys(extension));
    unique.set(key, extension);
  }

  return [...unique.values()].sort((a, b) => {
    const byPath = a.source_path.join(".").localeCompare(b.source_path.join("."));
    if (byPath !== 0) return byPath;
    return JSON.stringify(sortObjectKeys(a)).localeCompare(
      JSON.stringify(sortObjectKeys(b)),
    );
  });
}

function isScoutContractMapping(mapping: ScoutContractField): boolean {
  return (
    mapping.enabled &&
    mapping.source_stage === "research" &&
    mapping.required_from_agent &&
    mapping.source_path[0] === "custom_fields" &&
    mapping.source_path.length > 1
  );
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;

  const sorted: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).sort()) {
    sorted[key] = sortObjectKeys((value as JsonObject)[key]);
  }
  return sorted;
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (item !== undefined) out[key] = toJsonValue(item);
    }
    return out;
  }
  return String(value);
}
