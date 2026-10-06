import { z } from "zod";
import {
  MappingError,
  PropertySchema,
  type LeadSource,
  type Property,
  type State,
} from "./contracts.js";
import type { MappingSession } from "./transport.js";
import type { Properties, RemoteRecord, RemoteRecords, Surface } from "./preview.js";

// Attio People and Companies behind the provider-neutral mapper. Values are
// flattened exactly like the Jobs adapter reads them, so a preview's expected
// values match what the replay worker observes.
export const ATTIO_OBJECT: Record<Surface, "people" | "companies"> = { contact: "people", company: "companies" };
export const ATTIO_IDENTITY: Record<Surface, string> = { contact: "email_addresses", company: "domains" };
/** Attribute types the Jobs Attio serializer writes; others are read-only here. */
export const ATTIO_WRITABLE_TYPES = new Set(["text", "personal-name", "number", "checkbox", "select", "status", "date", "timestamp"]);

const Attribute = z.object({
  api_slug: z.string().min(1),
  title: z.string(),
  description: z.string().nullable().optional(),
  type: z.string(),
  is_writable: z.boolean(),
  is_archived: z.boolean(),
  is_multiselect: z.boolean().optional(),
});
const Option = z.object({ title: z.string(), is_archived: z.boolean().optional() });
const AttioRecordSchema = z.object({
  id: z.object({ record_id: z.string() }),
  web_url: z.string().optional(),
  values: z.record(z.string(), z.array(z.unknown())),
});
type AttioRecord = z.infer<typeof AttioRecordSchema>;

function data<T>(schema: z.ZodType<T>, body: unknown, code: string): T {
  const parsed = z.object({ data: schema }).safeParse(body);
  if (!parsed.success) throw new MappingError(code, 502);
  return parsed.data.data;
}

function normalize(attribute: z.infer<typeof Attribute>, options: z.infer<typeof Option>[] | null): Property {
  return PropertySchema.parse({
    name: attribute.api_slug,
    label: attribute.title,
    ...(attribute.description ? { description: attribute.description } : {}),
    type: attribute.type,
    fieldType: attribute.is_multiselect ? "multiselect" : "single",
    archived: attribute.is_archived,
    ...(options ? { options: options.map(option => ({ label: option.title, value: option.title, hidden: option.is_archived === true })) } : {}),
    modificationMetadata: { readOnlyValue: !attribute.is_writable || !ATTIO_WRITABLE_TYPES.has(attribute.type) },
  });
}

async function readAttribute(tools: MappingSession, state: State, object: Surface, attribute: z.infer<typeof Attribute>): Promise<Property> {
  if (!["select", "status"].includes(attribute.type) || attribute.is_archived) return normalize(attribute, null);
  const kind = attribute.type === "status" ? "statuses" : "options";
  const options = data(z.array(Option), await tools.call(state, "GET",
    `/objects/${ATTIO_OBJECT[object]}/attributes/${encodeURIComponent(attribute.api_slug)}/${kind}`), "INVALID_ATTIO_SCHEMA");
  return normalize(attribute, options);
}

export async function readAttioProperties(tools: MappingSession, state: State): Promise<Properties> {
  const read = async (object: Surface) => {
    const attributes = data(z.array(Attribute), await tools.call(state, "GET", `/objects/${ATTIO_OBJECT[object]}/attributes`), "INVALID_ATTIO_SCHEMA");
    const properties: Property[] = [];
    // Sequential option reads keep a large schema inside Attio's rate limit.
    for (const attribute of attributes) properties.push(await readAttribute(tools, state, object, attribute));
    return properties.sort((a, b) => a.name.localeCompare(b.name));
  };
  return { contact: await read("contact"), company: await read("company") };
}

/** First value only, as lift-gtm-jobs flattenAttioRecordValues does. */
export function flattenAttioValue(values: unknown[] | undefined): string | null {
  const first = values?.[0];
  if (!first || typeof first !== "object") return null;
  const value = first as Record<string, unknown>;
  const primitive = value.value ?? value.full_name ?? value.email_address ?? value.domain ?? value.target_record_id
    ?? (value.option && typeof value.option === "object" ? (value.option as Record<string, unknown>).title : undefined);
  return typeof primitive === "string" || typeof primitive === "number" || typeof primitive === "boolean" ? String(primitive) : null;
}

function identities(record: AttioRecord, object: Surface): string[] {
  const key = object === "contact" ? "email_address" : "domain";
  return (record.values[ATTIO_IDENTITY[object]] ?? []).flatMap(entry =>
    entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)[key] === "string" ? [(entry as Record<string, string>)[key]!] : []);
}

export async function readAttioRecords(tools: MappingSession, state: State, leads: LeadSource[], identityOnly = false): Promise<RemoteRecords> {
  const remote: RemoteRecords = { contact: new Map(), company: new Map() };
  for (const object of ["contact", "company"] as const) {
    const ids = [...new Set(leads.map(l => object === "contact" ? l.crm_contact_id : l.crm_company_id)
      .filter((id): id is string => !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))].sort();
    const fields = [...new Set([ATTIO_IDENTITY[object], ...(identityOnly ? [] : state.mappings
      .filter(m => m.enabled && m.destination_object === object).map(m => m.destination_field))])].sort();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const slice = ids.slice(offset, offset + 100);
      const records = data(z.array(AttioRecordSchema), await tools.call(state, "POST", `/objects/${ATTIO_OBJECT[object]}/records/query`,
        { filter: { record_id: { $in: slice } }, limit: slice.length }), "INVALID_ATTIO_RECORDS");
      for (const record of records) {
        if (!slice.includes(record.id.record_id)) continue;
        const entry: RemoteRecord = {
          values: Object.fromEntries(fields.map(field => [field, flattenAttioValue(record.values[field])])),
          identities: identities(record, object),
          url: record.web_url && /^https:\/\/app\.attio\.com\//.test(record.web_url) ? record.web_url : null,
        };
        remote[object].set(record.id.record_id, entry);
      }
    }
  }
  return remote;
}

/** Mirrors the Jobs Attio serializer: a value it would drop is invalid here. */
export function invalidAttioValue(property: Property, value: string): string | null {
  switch (property.type) {
    case "text": return null;
    case "personal-name": return value.trim() ? null : "invalid_value";
    case "number": return value.trim() && Number.isFinite(Number(value)) ? null : "invalid_number";
    case "checkbox": return ["true", "false"].includes(value.trim().toLowerCase()) ? null : "invalid_boolean";
    case "select":
    case "status":
      return property.options?.some(option => !option.hidden && option.value === value) ? null : "invalid_enum";
    case "date": return /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? null : "invalid_date";
    case "timestamp": return Number.isNaN(new Date(value).getTime()) ? "invalid_date" : null;
    default: return "unsupported_attribute_type";
  }
}

/** Creates the attribute (and select options), then reads it back. */
export async function createAttioAttribute(tools: MappingSession, state: State, object: Surface,
  definition: { name: string; label: string; description?: string | undefined; type: string; options?: { label: string }[] | undefined }): Promise<Property> {
  const base = `/objects/${ATTIO_OBJECT[object]}/attributes`;
  await tools.call(state, "POST", base, { data: {
    title: definition.label, description: definition.description ?? null, api_slug: definition.name, type: definition.type,
    is_required: false, is_unique: false, is_multiselect: false, config: {},
  } });
  for (const option of definition.options ?? []) {
    await tools.call(state, "POST", `${base}/${encodeURIComponent(definition.name)}/options`, { data: { title: option.label } });
  }
  const attribute = data(Attribute, await tools.call(state, "GET", `${base}/${encodeURIComponent(definition.name)}`), "ATTIO_ATTRIBUTE_READBACK_FAILED");
  return readAttribute(tools, state, object, attribute);
}
