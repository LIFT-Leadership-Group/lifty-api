import { expect, it } from "vitest";
import { getCrmSyncStatus } from "../src/workspace-operations.js";
const companyId = "85800000-0000-4000-a000-000000000001";
function receipt() {
  return { version: 1, status: "pending",
    contacts: { status: "complete", run_id: "run_contacts", expected: 4, synced: 4, selected: 4, summary: null },
    research: { status: "pending", run_id: "run_research", total: 0, summary: null, notes: "pending" },
    companies: { status: "pending", expected: 1, completed: 0, results: [{ company_id: companyId, run_id: "run_company", status: "pending", outcome: "in_progress", crm_company_id: "123", projection_source_research_id: companyId }] } };
}
function response() {
  return { state: "failed", run_ref: "run_parent", requested_leads: 4, leads_synced: 4, error_code: "crm_delivery_pending", portal_id: "123", started_at: "2026-09-16", completed_at: "2026-09-16", workspace: { workspace_ref: "workspace", name: "Fixture" }, crm_sync_receipt: receipt() };
}
async function read(data: unknown) { return getCrmSyncStatus({ userId: "founder", client: { rpc: async () => ({ data, error: null }) } }); }
it("forwards a scoped partial/pending receipt and existing child identities", async () => {
  const data = response(); expect(await read(data)).toEqual(data);
});
it("preserves legacy null receipts without claiming verified delivery", async () => {
  const data = { ...response(), crm_sync_receipt: null }; expect(await read(data)).toEqual(data);
});
it("rejects raw provider or unexpected child fields", async () => {
  const data = response(); Object.assign(data.crm_sync_receipt.research, { access_token: "never-forward" });
  await expect(read(data)).rejects.toMatchObject({ code: "SUPABASE_INVALID_RESPONSE" });
});
it("rejects succeeded with incomplete delivery and inconsistent full-success counts", async () => {
  await expect(read({ ...response(), state: "succeeded" })).rejects.toMatchObject({ code: "SUPABASE_INVALID_RESPONSE" });
  const data = response(); data.crm_sync_receipt.status = "complete";
  await expect(read(data)).rejects.toMatchObject({ code: "SUPABASE_INVALID_RESPONSE" });
});
it("rejects duplicate company counts", async () => {
  const data = response(); data.crm_sync_receipt.companies.results.push(data.crm_sync_receipt.companies.results[0]!);
  await expect(read(data)).rejects.toMatchObject({ code: "SUPABASE_INVALID_RESPONSE" });
});

it("accepts a complete receipt only after every stage has matching evidence", async () => {
  const data = response(); data.state = "succeeded"; data.error_code = "";
  const r = data.crm_sync_receipt; r.status = "complete";
  r.research = { ...r.research, status: "complete", total: 4, notes: "disabled" };
  r.companies.status = "complete"; r.companies.completed = 1;
  r.companies.results[0]!.status = "complete"; r.companies.results[0]!.outcome = "already_succeeded";
  const full = { ...data, crm_sync_receipt: { ...r,
    contacts: { ...r.contacts, summary: { successful: 4, failed: 0, quarantined: 0, contacts_created: 4, contacts_updated: 0, companies_created: 1, companies_linked: 3,
      build_results: { pushed: 4, skipped_missing_property: 0, skipped_no_value: 0, skipped_write_rule: 0, fallback_used: 0, sanitize_dropped_missing: 0, sanitize_dropped_invalid_enum: 0, sanitize_remapped_enum: 0 } } },
    research: { ...r.research, summary: { total: 4, pushed: 4, dry_run: 0, no_contact: 0, no_client: 0, no_research: 0, no_payload: 0, errored: 0, skipped_missing_properties: 0, skipped_no_value: 0, skipped_write_rule: 0, fallback_used: 0, sanitize_dropped_missing: 0, sanitize_dropped_invalid_enum: 0, sanitize_remapped_enum: 0, notes_created: 0, notes_updated: 0, notes_failed: 0, notes_skipped: 4, notes_disabled: 4 } },
  } };
  expect(await read(full)).toEqual(full);
});
