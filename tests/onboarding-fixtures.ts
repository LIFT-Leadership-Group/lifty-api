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
