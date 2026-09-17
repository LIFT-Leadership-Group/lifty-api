import { buildCrmPropertyPayload } from "../generated/crm-shared/index.js";
import {
  fingerprint,
  type State,
  type Property,
  type LeadSource,
  type ReplayPlan,
  CrmMappingPreviewSchema,
} from "./contracts.js";
export type Surface = "contact" | "company";
export type Properties = Record<Surface, Property[]>;
export type RemoteRecords = Record<
  Surface,
  Map<string, Record<string, string | null>>
>;
export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return (
      new URL(value.includes("://") ? value : `https://${value}`).hostname
        .toLowerCase()
        .replace(/^www\./, "") || null
    );
  } catch {
    return null;
  }
}
export function matchesIdentity(
  lead: LeadSource,
  object: Surface,
  remote: Record<string, string | null>,
): boolean {
  if (object === "company") {
    const expected = normalizeDomain(
      lead.company_discovery?.company_domain ?? lead.discovery.company_domain,
    );
    return expected !== null && normalizeDomain(remote.domain) === expected;
  }
  const email = lead.discovery.email;
  return (
    typeof email === "string" &&
    email.trim().length > 0 &&
    email.trim().toLowerCase() === remote.email?.trim().toLowerCase()
  );
}
export function invalidPropertyValue(
  property: Property | undefined,
  value: string,
): string | null {
  if (!property || property.archived) return "missing_property";
  if (property.modificationMetadata?.readOnlyValue) return "read_only_property";
  if (property.type === "enumeration") {
    const allowed = new Set(
      property.options?.filter((o) => !o.hidden).map((o) => o.value),
    );
    const values =
      property.fieldType === "checkbox" ? value.split(";") : [value];
    if (values.some((v) => !allowed.has(v))) return "invalid_enum";
  } else if (
    property.type === "number" &&
    (!value.trim() || !Number.isFinite(Number(value)))
  )
    return "invalid_number";
  else if (property.type === "bool" && !["true", "false"].includes(value))
    return "invalid_boolean";
  else if (
    ["date", "datetime"].includes(property.type) &&
    !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) &&
    !/^\d+$/.test(value)
  )
    return "invalid_date";
  return null;
}
export async function buildPreview(
  state: State,
  properties: Properties,
  leads: LeadSource[],
  remote: RemoteRecords,
  appliedMapping: boolean,
) {
  const issues: {
    lead_ref: string;
    object: Surface;
    field: string | null;
    reason: string;
    value?: string;
  }[] = [];
  const records = new Map<string, ReplayPlan["records"][number]>();
  const conflicted = new Set<string>();
  for (const lead of leads)
    for (const object of ["contact", "company"] as const) {
      const mappings = state.mappings.filter(
        (m) => m.enabled && m.destination_object === object,
      );
      if (!mappings.length) continue;
      const id =
        object === "contact" ? lead.crm_contact_id : lead.crm_company_id;
      const current = id ? remote[object].get(id) : undefined;
      const issue = (
        reason: string,
        field: string | null = null,
        value?: string,
      ) =>
        issues.push({
          lead_ref: lead.lead_ref,
          object,
          field,
          reason,
          ...(value === undefined ? {} : { value }),
        });
      if (!id || !/^\d{1,30}$/.test(id)) {
        issue("missing_record");
        continue;
      }
      if (!current) {
        issue("record_unavailable");
        continue;
      }
      if (!matchesIdentity(lead, object, current)) {
        issue("identity_mismatch");
        continue;
      }
      const identity = object === "contact" ? "email" : "domain";
      const expected: Record<string, string | null> = {
        [identity]: current[identity] ?? null,
      };
      for (const mapping of mappings)
        expected[mapping.destination_field] =
          current[mapping.destination_field] ?? null;
      const key = `${object}:${id}`;
      const record = records.get(key) ?? {
        lead_refs: [],
        object,
        record_id: id,
        expected,
        proposed: {},
        evaluations: [],
      };
      if (!record.lead_refs.includes(lead.lead_ref))
        record.lead_refs.push(lead.lead_ref);
      for (const stage of [
        "discovery",
        "research",
        "outreach",
        "verification",
      ] as const)
        for (const entity of ["lead", "company"] as const) {
          const rows = mappings.filter(
            (m) => m.source_stage === stage && m.source_entity === entity,
          );
          if (!rows.length) continue;
          const source =
            stage === "discovery"
              ? entity === "company"
                ? lead.company_discovery
                : lead.discovery
              : stage === "research"
                ? entity === "company"
                  ? lead.company_research
                  : lead.lead_research
                : null;
          if (!source) {
            for (const row of rows)
              issue("source_unavailable", row.destination_field);
            continue;
          }
          // Runtime/counterpart sources need their originating event context and are not replayed as discovery/research facts.
          const eligible = rows.filter(
            (row) =>
              !["runtime", "counterpart_property"].includes(row.value_source),
          );
          for (const row of rows.filter((row) => !eligible.includes(row)))
            issue("source_context_required", row.destination_field);
          const result = buildCrmPropertyPayload({
            provider: "hubspot",
            mappings: eligible,
            source,
            stage,
            sourceEntity: entity,
            destinationObject: object,
            writeMode: "update",
            existingProperties: expected,
          });
          for (const entry of result.skipped_no_value)
            issue("skipped_no_value", entry.destination_field);
          for (const entry of result.skipped_write_rule)
            issue("skipped_write_rule", entry.destination_field);
          const validFields = new Set<string>();
          for (const [field, value] of Object.entries(result.payload)) {
            const invalid = invalidPropertyValue(
              properties[object].find((p) => p.name === field),
              value,
            );
            if (invalid) {
              issue(invalid, field, value);
              continue;
            }
            if (
              record.proposed[field] !== undefined &&
              record.proposed[field] !== value
            ) {
              issue("conflicting_sources", field);
              conflicted.add(key);
              continue;
            }
            record.proposed[field] = value;
            validFields.add(field);
          }
          if (validFields.size)
            record.evaluations.push({
              stage,
              entity,
              source,
              mappings: eligible.filter((m) =>
                validFields.has(m.destination_field),
              ),
            });
        }
      records.set(key, record);
    }
  const plan: ReplayPlan = {
    version: 1,
    records: [...records]
      .filter(
        ([key, r]) =>
          !conflicted.has(key) && Object.keys(r.proposed).length > 0,
      )
      .map(([, r]) => ({ ...r, lead_refs: r.lead_refs.sort() }))
      .sort((a, b) =>
        `${a.object}:${a.record_id}`.localeCompare(
          `${b.object}:${b.record_id}`,
        ),
      ),
  };
  const content = {
    workspace_ref: state.workspace_ref,
    integration_ref: state.integration_ref,
    portal_id: state.portal_id,
    mapping_version: state.mapping_version,
    schema_version: await fingerprint(properties),
    lead_refs: leads.map((l) => l.lead_ref).sort(),
    applied_mapping: appliedMapping,
    plan,
    issues,
  };
  return CrmMappingPreviewSchema.parse({
    ...content,
    preview_digest: await fingerprint(content),
  });
}
