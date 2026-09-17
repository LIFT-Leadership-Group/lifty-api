import { z } from "zod";
import {
  PropertySchema,
  MappingError,
  type State,
  type LeadSource,
} from "./contracts.js";
import type { MappingSession } from "./transport.js";
import type { Properties, RemoteRecords, Surface } from "./preview.js";
export async function readProperties(
  tools: MappingSession,
  state: State,
): Promise<Properties> {
  const read = async (object: Surface) => {
    const result = z
      .object({ results: z.array(PropertySchema) })
      .safeParse(
        await tools.call(
          state,
          "GET",
          `/crm/v3/properties/${object === "contact" ? "contacts" : "companies"}?archived=false`,
        ),
      );
    if (!result.success) throw new MappingError("INVALID_HUBSPOT_SCHEMA", 502);
    return result.data.results.sort((a, b) => a.name.localeCompare(b.name));
  };
  const [contact, company] = await Promise.all([
    read("contact"),
    read("company"),
  ]);
  return { contact, company };
}
export async function readRecords(
  tools: MappingSession,
  state: State,
  leads: LeadSource[],
  identityOnly = false,
): Promise<RemoteRecords> {
  const remote: RemoteRecords = { contact: new Map(), company: new Map() };
  for (const object of ["contact", "company"] as const) {
    const ids = [
      ...new Set(
        leads
          .map((l) =>
            object === "contact" ? l.crm_contact_id : l.crm_company_id,
          )
          .filter((id): id is string => !!id && /^\d{1,30}$/.test(id)),
      ),
    ].sort();
    const properties = [
      ...new Set([
        object === "contact" ? "email" : "domain",
        ...(identityOnly
          ? []
          : state.mappings
              .filter((m) => m.enabled && m.destination_object === object)
              .map((m) => m.destination_field)),
      ]),
    ].sort();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const slice = ids.slice(offset, offset + 100);
      const data = z
        .object({
          results: z.array(
            z.object({
              id: z.string(),
              archived: z.boolean().optional(),
              properties: z.record(z.string(), z.string().nullable()),
            }),
          ),
        })
        .safeParse(
          await tools.call(
            state,
            "POST",
            `/crm/v3/objects/${object === "contact" ? "contacts" : "companies"}/batch/read`,
            { properties, inputs: slice.map((id) => ({ id })) },
          ),
        );
      if (!data.success) throw new MappingError("INVALID_HUBSPOT_RECORDS", 502);
      for (const row of data.data.results)
        if (slice.includes(row.id) && !row.archived)
          remote[object].set(
            row.id,
            Object.fromEntries(
              properties.map((key) => [key, row.properties[key] ?? null]),
            ),
          );
    }
  }
  return remote;
}
