import { z } from "zod";

const count = z.number().int().nonnegative();
const status = z.enum(["pending", "complete", "partial", "failed"]);
const runId = z.string().min(1).max(200);
const buildSummary = z.object({
  pushed: count, skipped_missing_property: count, skipped_no_value: count, skipped_write_rule: count,
  fallback_used: count, sanitize_dropped_missing: count, sanitize_dropped_invalid_enum: count, sanitize_remapped_enum: count,
}).strict();
const contactSummary = z.object({
  successful: count, failed: count, quarantined: count, contacts_created: count, contacts_updated: count,
  companies_created: count, companies_linked: count, build_results: buildSummary,
}).strict();
const researchSummary = z.object({
  total: count, pushed: count, dry_run: count, no_contact: count, no_client: count, no_research: count,
  no_payload: count, errored: count, skipped_missing_properties: count, skipped_no_value: count,
  skipped_write_rule: count, fallback_used: count, sanitize_dropped_missing: count,
  sanitize_dropped_invalid_enum: count, sanitize_remapped_enum: count,
  notes_created: count, notes_updated: count, notes_failed: count, notes_skipped: count, notes_disabled: count,
}).strict();

/** Deliberately allowlisted: raw child/provider output never crosses the public
 * boundary. Existing null receipts remain readable as unverified history. */
export const CrmSyncReceiptSchema = z.object({
  version: z.literal(1), status,
  contacts: z.object({ status, run_id: runId.nullable(), expected: count.max(2_000), synced: count.max(2_000), selected: count.max(2_000), summary: contactSummary.nullable() }).strict(),
  research: z.object({ status, run_id: runId.nullable(), total: count.max(2_000), summary: researchSummary.nullable(), notes: z.enum(["pending", "complete", "partial", "disabled"]) }).strict(),
  companies: z.object({
    status, expected: count.max(2_000), completed: count.max(2_000),
    results: z.array(z.object({
      company_id: z.string().uuid(), run_id: runId, status,
      outcome: z.enum(["succeeded", "already_succeeded", "refused", "ineligible", "dry_run", "in_progress", "partial", "failed", "conflict", "task_failed"]),
      crm_company_id: z.string().min(1).max(200).nullable(), projection_source_research_id: z.string().uuid().nullable(),
    }).strict()).max(2_000),
  }).strict(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.contacts.synced > receipt.contacts.expected || receipt.companies.completed > receipt.companies.expected
    || receipt.companies.completed !== receipt.companies.results.filter(result => result.status === "complete").length
    || new Set(receipt.companies.results.map(result => result.company_id)).size !== receipt.companies.results.length) {
    ctx.addIssue({ code: "custom", message: "Inconsistent CRM delivery counts" });
  }
  if (receipt.status === "complete" && (
    [receipt.contacts, receipt.research, receipt.companies].some(stage => stage.status !== "complete")
    || !receipt.contacts.run_id || !receipt.research.run_id || !receipt.contacts.summary || !receipt.research.summary
    || receipt.contacts.expected === 0 || receipt.contacts.synced !== receipt.contacts.expected
    || receipt.research.total !== receipt.contacts.expected || receipt.companies.expected === 0
    || receipt.companies.completed !== receipt.companies.expected
    || receipt.companies.results.some(result => !result.crm_company_id || !result.projection_source_research_id || !["succeeded", "already_succeeded"].includes(result.outcome))
  )) ctx.addIssue({ code: "custom", message: "Incomplete CRM delivery cannot be complete" });
});
