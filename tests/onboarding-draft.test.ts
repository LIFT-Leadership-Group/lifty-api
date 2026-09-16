import { describe, expect, it, vi } from "vitest";
import { lintOnboardingDraft } from "../src/onboarding-draft.js";
import { createCurrentClient as createApp } from "./current-client.js";
import { confirmedDraft, localConfiguration, onboardingContext } from "./onboarding-fixtures.js";

const finding = { field: "company.name", value: "Example", source: "Founder's website", state: "founder_confirmed", used_in_configuration: true, founder_confirmation: "Confirmed" };
const badDrafts = [
  { ...confirmedDraft, primary_motion: undefined },
  { ...confirmedDraft, primary_motion: { name: " ", outcome: " " } },
  { ...confirmedDraft, calibration: { status: "accepted", lead_target: 5 } },
  { ...confirmedDraft, outreach: { status: "sending" } },
  { ...confirmedDraft, research_findings: [{ ...finding, state: "inferred", founder_confirmation: null }] },
  { ...confirmedDraft, research_findings: [{ ...finding, value: "Unconfirmed company" }] },
  { ...confirmedDraft, research_findings: [{ ...finding, field: "research_findings.0.source", value: finding.source }] },
  { ...confirmedDraft, founder_statement_history: [{ sequence: 1, field: "company.name", value: "Example" }, { sequence: 2, field: "company.name", value: "Latest founder name" }] },
  { ...confirmedDraft, founder_statement_history: [{ sequence: 1, field: "company.name", value: "Example" }, { sequence: 1, field: "company.name", value: "Example" }] },
];
describe("API-owned onboarding decisions", () => {
  it("accepts the current schema and latest matching confirmed decisions", () => {
    expect(lintOnboardingDraft({ ...confirmedDraft, research_findings: [finding], founder_statement_history: [
      { sequence: 2, field: "company.name", value: "Example" }, { sequence: 1, field: "company.name", value: "Old name" },
    ] })).toEqual([]);
  });
  it.each(badDrafts)("rejects missing or contradictory decisions without persistence through legacy and stage entrypoints", async draft => {
    const submit = vi.fn(); const enqueue = vi.fn(); const log = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" }, next_action: null }),
      getOnboardingContext: async () => onboardingContext, submitOnboarding: submit, enqueueOnboardingImport: enqueue, log });
    for (const path of ["/v1/onboarding", "/v1/workspace/targeting"]) {
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-lifty-client-contract": "lifty-cli-context.v5" }, body: JSON.stringify({ draft, configuration: localConfiguration }) });
      expect(response.status).toBe(422);
      const result = await response.json();
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(result)).not.toContain("Unconfirmed company");
    }
    expect(submit).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("Unconfirmed company");
  });
});
