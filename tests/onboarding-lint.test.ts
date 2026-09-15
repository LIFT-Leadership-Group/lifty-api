import { describe, expect, it } from "vitest";
import { lintLocalOnboardingConfiguration } from "../src/onboarding-lint.js";
import { localConfiguration } from "./onboarding-fixtures.js";

const draft = { personas: localConfiguration.icp_config.personas };
const copy = () => structuredClone(localConfiguration);

function issues(candidate: unknown, inputDraft = draft, base?: string | null) {
  const result = lintLocalOnboardingConfiguration(candidate, inputDraft, base);
  if (result.success) throw new Error("Expected lint failure");
  return result.issues;
}

describe("deterministic onboarding repair diagnostics", () => {
  it("accepts an explicit null policy, retained titles and open employee range", () => {
    const candidate = copy();
    candidate.icp_config.organization_num_employees_ranges = ["51,"];
    candidate.icp_config.personas[0]!.titles = ["FOUNDER", "CEO"];
    expect(lintLocalOnboardingConfiguration(candidate, draft)).toEqual({ success: true, configuration: candidate });
  });

  it("collects independent repair issues with safe JSON-pointer paths", () => {
    const candidate = copy();
    candidate.icp_config.label = " ";
    candidate.icp_config.person_locations = ["United States", " united states "];
    candidate.icp_config.person_seniorities = ["private-input-seniority"];
    candidate.icp_config.organization_num_employees_ranges = ["200,51", "9007199254740992,"];
    candidate.icp_config.personas[0]!.titles = ["private-input-title"];
    candidate.scout_overlay = "private-input-overlay ".repeat(30);
    const result = issues(candidate);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "blank_value", path: "/configuration/icp_config/label" }),
      expect.objectContaining({ code: "duplicate_value", path: "/configuration/icp_config/person_locations/1" }),
      expect.objectContaining({ code: "unsupported_seniority", path: "/configuration/icp_config/person_seniorities/0" }),
      expect.objectContaining({ code: "invalid_employee_bounds", path: "/configuration/icp_config/organization_num_employees_ranges/0" }),
      expect.objectContaining({ code: "invalid_employee_bounds", path: "/configuration/icp_config/organization_num_employees_ranges/1" }),
      expect.objectContaining({ code: "confirmed_titles_missing", path: "/configuration/icp_config/personas/0/titles" }),
      expect.objectContaining({ code: "overlay_sections_invalid", path: "/configuration/scout_overlay" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private-input");
    expect(result.every((issue) => issue.suggestion.length > 20)).toBe(true);
  });

  it.each(["renamed", "extra", "missing", "duplicate"])("requires the exact confirmed persona set: %s", (change) => {
    const candidate = copy();
    if (change === "renamed") candidate.icp_config.personas[0]!.name = "Different";
    if (change === "extra") candidate.icp_config.personas.push({ name: "Extra", titles: ["Extra"] });
    if (change === "missing") candidate.icp_config.personas = [];
    if (change === "duplicate") candidate.icp_config.personas.push(candidate.icp_config.personas[0]!);
    expect(issues(candidate)).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(/^\/configuration\/icp_config\/personas/) })]));
  });

  it("rejects reordered or repeated Scout sections", () => {
    const candidate = copy();
    candidate.scout_overlay = candidate.scout_overlay.replace("## ICP gate", "## Size gate");
    expect(issues(candidate)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "overlay_sections_invalid" })]));
  });

  it("reports overlay budget and copied global base separately", () => {
    const candidate = copy();
    candidate.scout_overlay += `\n${"x".repeat(52_000)}\nprivate-global-base`;
    const result = issues(candidate, draft, "private-global-base");
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "overlay_too_large", suggestion: expect.stringContaining("52,000") }),
      expect.objectContaining({ code: "global_base_copied" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private-global-base");
  });

  it("bounds shape diagnostics and never echoes unknown keys or input values", () => {
    const candidate = copy();
    candidate.icp_config.personas = Array.from({ length: 40 }, () => ({ name: "", titles: [] }));
    const result = issues({ ...candidate, "private-secret-key": "private-secret-value" });
    expect(result).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("bounds semantic diagnostics", () => {
    const candidate = copy();
    candidate.icp_config.person_locations = Array.from({ length: 40 }, () => " ");
    expect(issues(candidate)).toHaveLength(20);
  });

  it("reports malformed draft personas at the draft pointer", () => {
    expect(issues(copy(), { personas: [] })).toEqual([expect.objectContaining({ code: "draft_personas_invalid", path: "/draft/personas" })]);
  });
});
