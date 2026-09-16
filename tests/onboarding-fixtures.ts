import type { LocalOnboardingConfiguration, OnboardingContext } from "../src/contracts.js";

export const localConfiguration: LocalOnboardingConfiguration = {
  contract_version: "lifty-onboarding-config.v1",
  context_version: `sha256:${"b".repeat(64)}`,
  icp_config: {
    label: "Example ICP",
    person_locations: ["United States"],
    organization_industries: ["computer software"],
    organization_num_employees_ranges: ["51,200"],
    person_seniorities: null,
    personas: [{ name: "Founder", titles: ["Founder"] }],
  },
  scout_overlay: ["## ICP gate", "Local research instructions. ".repeat(12), "## Hard disqualifiers", "Reject agencies.", "## Size gate", "Use the confirmed size.", "## Tier definitions", "Use A/B/C/non-ICP tiers."].join("\n"),
};

export const onboardingContext: OnboardingContext = {
  contract_version: localConfiguration.contract_version,
  generation_policy: "evidence_search_v1",
  context_version: localConfiguration.context_version,
  workspace: { workspace_ref: "ws_opaque", name: "Example", description: null },
  scout_global_base: "Global Scout rules.",
};

export const confirmedDraft = {
  schema_version: "2.1", status: "ready_for_auth", stage: "icp_bootstrap",
  company: { name: "Example", description: "Software for growing commercial teams.", example_companies: [] },
  primary_motion: { name: "Software", outcome: "Help commercial teams grow" }, parked_secondary_motions: [],
  icp: { industries_in: ["computer software"], industries_out: ["agencies"],
    size: { floor: 51, ceiling: 200, unit: "employees" }, hard_disqualifiers: ["Agencies"], operating_state_split: null,
    discovery: { person_locations: ["United States"], organization_locations: null, employee_range_proxy: null,
      q_keywords: null, broad_search_confirmed: false } },
  personas: [{ name: "Founder", role: "decision_maker", titles: ["Founder"], tell: "Leads company growth" }],
  calibration: { status: "pending_sample", lead_target: 5 }, outreach: { status: "deferred_until_sample_accepted" },
  research_findings: [], founder_statement_history: [],
};
