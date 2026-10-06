import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";

const MAX_CSV_BYTES = 128 * 1024;
const MAX_ROWS = 5000;
const MAX_IDENTITIES = 10000;
const MAX_COLUMNS = 32;
const Empty = z.object({}).strict();
const Count = z.number().int().nonnegative();
const Revision = z.string().regex(/^[a-f0-9]{64}$/);
const RejectedRow = z.object({
  row: z.number().int().positive(),
  reason: z.enum(["invalid_domain", "invalid_email", "free_mail_domain", "missing_identity", "column_count", "malformed_csv"]),
}).strict();
export const CustomerExclusionsImportRequest = z.object({
  csv: z.string().min(1).max(MAX_CSV_BYTES).describe("UTF-8 CSV, at most 128 KiB and 5000 data rows, with domain/company_domain/website and/or email columns. Replaces the founder-uploaded list; a header-only CSV clears it."),
}).strict();
export const CustomerExclusionsReceipt = z.object({
  workspace_ref: z.uuid(), revision: Revision.nullable(), imported_at: z.iso.datetime({ offset: true }).nullable(), domain_count: Count, email_count: Count,
  uploaded_domain_count: Count, uploaded_email_count: Count,
  accepted_rows: Count, rejected_count: Count, rejected_rows: z.array(RejectedRow).max(10000),
  added_domains: Count, removed_domains: Count, added_emails: Count, removed_emails: Count,
}).strict();
export const CustomerExclusionsStatus = CustomerExclusionsReceipt.extend({ candidates_excluded: Count }).strict();
// LIF-1128: the CRM-derived customer list's freshness, decided in the database
// from the nightly sync ledger. Null when that read is unavailable.
const Stamp = z.iso.datetime({ offset: true });
const CrmRefreshSource = z.object({
  source: z.enum(["crm_closed_won", "crm_customer", "crm_open_deal"]), required: z.boolean(),
  last_status: z.enum(["ok", "failed", "skipped", "unsupported", "off"]).nullable(),
  last_attempt_at: Stamp.nullable(), last_success_at: Stamp.nullable(), fresh: z.boolean(), stored_domains: Count,
}).strict();
export const CrmRefresh = z.object({
  state: z.enum(["fresh", "stale", "missing", "not_required"]), reason: z.string().max(100).nullable(),
  crm_scope: z.enum(["connected", "disconnected", "never_connected"]), provider: z.enum(["hubspot", "attio"]).nullable(),
  active_outreach: z.boolean(), fresh_within_hours: z.number().int().positive(), checked_at: Stamp,
  last_attempt_at: Stamp.nullable(), last_attempt_status: z.enum(["succeeded", "provider_failed", "skipped"]).nullable(),
  last_skip_reason: z.string().max(100).nullable(), sources: z.array(CrmRefreshSource).length(3),
}).strict();
export const CustomerExclusionsStatusRead = CustomerExclusionsStatus.extend({ crm_refresh: CrmRefresh.nullable() }).strict();
// The existing company identity policy in Jobs uses this same list. Personal
// mail hosts cannot identify a customer company; exact emails remain valid.
const freeMailDomains = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);
const domainHeaders = new Set(["domain", "company_domain", "company_website", "website"]);
const emailHeaders = new Set(["email", "email_address", "person_email", "customer_email"]);
const invalidCode = "CUSTOMER_EXCLUSIONS_INVALID";
const invalid = (message: string) => new PublicError({ status: 422, code: invalidCode, message });
const tooLarge = () => new PublicError({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "Use a CSV of at most 128 KiB, 5000 data rows, 32 columns and 10000 distinct customer identities." });

export function validateCustomerExclusionsInput(schema: z.ZodType, input: unknown, write: boolean): unknown {
  if (write && input && typeof input === "object" && "csv" in input && typeof input.csv === "string" && Buffer.byteLength(input.csv, "utf8") > MAX_CSV_BYTES) throw tooLarge();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PublicError({
    status: write ? 422 : 400, code: write ? invalidCode : "INVALID_REQUEST",
    message: write ? "Supply a customer CSV using the current import schema." : "Use the current customer exclusion query schema.",
    issues: parsed.error.issues.slice(0, 20).map(issue => ({
      code: issue.code, path: `/${issue.path.map(String).join("/")}`, message: "This field does not match the current schema.",
      suggestion: "Send only the fields published by this operation.",
    })),
  });
  return parsed.data;
}

type CsvRow = { row: number; fields: string[]; malformed: boolean };
// A bounded CSV reader keeps escaped quotes and quoted commas/newlines. An
// unclosed quote makes record boundaries uncertain: refuse the file instead
// of replacing the saved list with a guessed partial import.
function readCsv(input: string): CsvRow[] {
  if (Buffer.byteLength(input, "utf8") > MAX_CSV_BYTES) throw tooLarge();
  const csv = input.replace(/^\uFEFF/, "");
  const rows: CsvRow[] = [];
  let fields: string[] = [], field = "", quoted = false, closed = false, malformed = false, quotedRecord = false, row = 1;
  const finishField = () => {
    fields.push(field.trim()); field = ""; closed = false;
    if (fields.length > MAX_COLUMNS) throw tooLarge();
  };
  const finishRow = () => {
    finishField();
    if (fields.length > 1 || fields[0] !== "" || quotedRecord) rows.push({ row, fields, malformed });
    fields = []; malformed = false; quotedRecord = false; row++;
    if (rows.length > MAX_ROWS + 1) throw tooLarge();
  };
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ",") finishField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && csv[i + 1] === "\n") i++;
      finishRow();
    } else if (char === '"' && !closed && !field.trim()) { field = ""; quoted = true; quotedRecord = true; }
    else {
      if (char === '"' || (closed && char.trim())) malformed = true;
      field += char;
    }
  }
  if (quoted) throw invalid("Close every quoted CSV field before importing. No customer exclusions were changed.");
  if (field || fields.length || closed) finishRow();
  return rows;
}

function normalizedDomain(value: string): string | null {
  if (value.length > 2048 || /[\s\u0000-\u001f\\]/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return null;
  let host: string;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (url.username || url.password) return null;
    host = domainToASCII(url.hostname).toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  } catch { return null; }
  if (!host || host.length > 253 || /^[0-9.]+$/.test(host)) return null;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : null;
}
function normalizedEmail(value: string): string | null {
  const email = value.toLowerCase();
  if (email.length > 254 || !z.email().safeParse(email).success) return null;
  return email;
}

function importArguments(csv: string): Record<string, unknown> {
  const rows = readCsv(csv);
  const header = rows.shift();
  if (!header || header.malformed) throw invalid("Supply a CSV header with company domains and/or person emails.");
  const headers = header.fields.map(value => value.toLowerCase().replace(/[\s-]+/g, "_"));
  const domainIndexes = headers.flatMap((value, index) => domainHeaders.has(value) ? [index] : []);
  const emailIndexes = headers.flatMap((value, index) => emailHeaders.has(value) ? [index] : []);
  if (!domainIndexes.length && !emailIndexes.length) throw invalid("Use a domain, company_domain, website or email CSV column.");
  const domains = new Set<string>(), emails = new Set<string>();
  const rejected_rows: z.infer<typeof RejectedRow>[] = [];
  let accepted_rows = 0;
  for (const record of rows) {
    let reason: z.infer<typeof RejectedRow>["reason"] | undefined = record.malformed ? "malformed_csv" : record.fields.length !== headers.length ? "column_count" : undefined;
    const rowDomains: string[] = [], rowEmails: string[] = [];
    let freeMail = false;
    if (!reason) {
      for (const index of domainIndexes) {
        const value = record.fields[index]!;
        if (!value) continue;
        const domain = normalizedDomain(value);
        if (!domain) { reason = "invalid_domain"; break; }
        if (freeMailDomains.has(domain)) freeMail = true;
        else rowDomains.push(domain);
      }
      if (!reason) for (const index of emailIndexes) {
        const value = record.fields[index]!;
        if (!value) continue;
        const email = normalizedEmail(value);
        if (!email) { reason = "invalid_email"; break; }
        rowEmails.push(email);
      }
      if (!reason && !rowDomains.length && !rowEmails.length) reason = freeMail ? "free_mail_domain" : "missing_identity";
    }
    if (reason) rejected_rows.push({ row: record.row, reason });
    else {
      accepted_rows++;
      rowDomains.forEach(domain => domains.add(domain));
      rowEmails.forEach(email => emails.add(email));
      if (domains.size + emails.size > MAX_IDENTITIES) throw tooLarge();
    }
  }
  if (!accepted_rows && rejected_rows.length) throw new PublicError({
    status: 422, code: invalidCode,
    message: "Every customer row was rejected. Repair the file; the saved customer list was preserved. Use a header-only CSV to clear it explicitly.",
    issues: rejected_rows.slice(0, 20).map(({ row, reason }) => ({
      code: reason, path: `/csv/rows/${row}`, message: `CSV record ${row}: ${reason}.`,
      suggestion: "Provide a valid company domain or exact person email in this record.",
    })),
  });
  const normalized = { domains: [...domains].sort(), emails: [...emails].sort(), accepted_rows, rejected_rows };
  return {
    p_revision: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    p_domains: normalized.domains, p_emails: normalized.emails, p_accepted_rows: accepted_rows, p_rejected_rows: rejected_rows,
  };
}

const route = "/v1/workspace/customer-exclusions";
export const customerExclusionsOperationDefinitions = {
  "customer-exclusions": {
    status: {
      method: "GET", route, cli: { operation: "status" }, rpc: "get_workspace_customer_exclusions", path: Empty,
      query: Empty, request: null, invalid: { status: 400, code: "INVALID_REQUEST" }, response: CustomerExclusionsStatusRead,
      success: 200, args: () => ({}),
      description: "Read total saved and founder-uploaded customer domain/email counts, the latest founder CSV import revision, accepted/rejected rows with reasons, founder-upload added/removed counts and candidates excluded. Total saved domains include CRM and manual protections. crm_refresh reports whether the CRM-derived customer list is fresh, stale, missing or not required, with the reason and each source's last attempt and success; null means it could not be read. Read-only; unavailable does not mean an empty list.",
    },
    import: {
      method: "POST", route: `${route}/import`, cli: { operation: "import" }, rpc: "replace_workspace_customer_exclusions", path: Empty,
      query: Empty, request: CustomerExclusionsImportRequest, invalid: { status: 422, code: invalidCode }, response: CustomerExclusionsStatus,
      success: 200, args: input => importArguments(CustomerExclusionsImportRequest.parse(input.body).csv),
      description: "Replace this workspace's founder-uploaded customers from a CSV of company domains and/or exact emails. Deduplicates case/scheme/www domain variants; free-mail hosts protect only exact emails. Rejected rows contain row numbers and reasons. Returns saved counts and added/removed counts; a header-only CSV clears the founder upload. CRM/manual protections remain. Does not acquire leads, call a provider, resume research or send outreach.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;
export const customerExclusionsEntries = () => Object.entries(customerExclusionsOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, definition: definition as IdentityDefinition })));

export async function executeCustomerExclusionsOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown> {
  const entry = customerExclusionsEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown customer exclusion operation");
  const { definition } = entry;
  const unavailable = { code: "CUSTOMER_EXCLUSIONS_UNAVAILABLE", message: "Customer exclusions could not be verified. Read status again before retrying an import." };
  const args = { p_workspace: null, ...definition.args(input) };
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }).rpc(definition.rpc, args); }
  catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
  if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
  const status = key === "customer-exclusions.status";
  const parsed = (status ? CustomerExclusionsStatus : definition.response).safeParse(result.data);
  if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
  if (!status) return parsed.data;
  const receipt = parsed.data as z.infer<typeof CustomerExclusionsStatus>;
  return { ...receipt, crm_refresh: await readCrmRefresh(session, receipt.workspace_ref) };
}

// The founder list stays readable when only the CRM freshness read fails; the
// same tenant boundary applies, and a foreign answer is discarded.
async function readCrmRefresh(session: AuthSession, workspaceRef: string): Promise<z.infer<typeof CrmRefresh> | null> {
  try {
    const result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
      .rpc("get_workspace_suppression_freshness", { p_workspace: null });
    if (result.error || !result.data || typeof result.data !== "object") return null;
    const { workspace_ref: ref, ...value } = result.data as Record<string, unknown>;
    const parsed = CrmRefresh.safeParse(value);
    return ref === workspaceRef && parsed.success ? parsed.data : null;
  } catch { return null; }
}
