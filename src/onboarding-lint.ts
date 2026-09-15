import { z } from "zod";
import { LocalOnboardingConfigurationSchema, type LocalOnboardingConfiguration } from "./contracts.js";

export const OnboardingLintIssueSchema = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
  suggestion: z.string(),
}).strict();
export type OnboardingLintIssue = z.infer<typeof OnboardingLintIssueSchema>;
type LintResult = { success: true; configuration: LocalOnboardingConfiguration }
  | { success: false; issues: OnboardingLintIssue[] };

const SENIORITIES = new Set(["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager"]);
const HEADINGS = ["## ICP gate", "## Hard disqualifiers", "## Size gate", "## Tier definitions"];
const DraftPersonas = z.array(z.object({ name: z.string().min(1), titles: z.array(z.string().min(1)).min(1) })).min(1);
const normalize = (value: string) => value.trim().toLowerCase();
const pointer = (path: PropertyKey[]) => `/configuration${path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("")}`;

/** Returns bounded repair instructions, never submitted values or raw Zod messages. */
export function lintLocalOnboardingConfiguration(
  candidate: unknown,
  draft: Record<string, unknown>,
  scoutGlobalBase?: string | null,
): LintResult {
  const issues: OnboardingLintIssue[] = [];
  const add = (code: string, path: string, message: string, suggestion: string) => {
    if (issues.length < 20) issues.push({ code, path, message, suggestion });
  };
  const parsed = LocalOnboardingConfigurationSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = pointer(issue.path);
      let suggestion = "Use the published onboarding configuration schema; provide required fields with the documented types and remove unknown fields.";
      if (issue.path[0] === "contract_version") suggestion = "Set contract_version to lifty-onboarding-config.v1 using the current onboarding skill.";
      else if (issue.path[0] === "context_version") suggestion = "Fetch /v1/onboarding/context and copy its context_version unchanged.";
      else if (issue.path[0] === "scout_overlay") suggestion = "Write a Scout overlay of at least 200 characters using the four required sections.";
      else if (issue.path.includes("organization_num_employees_ranges")) suggestion = "Use employee bands formatted as minimum,maximum or minimum, for an open upper bound; use null for non-employee size criteria.";
      else if (issue.code === "unrecognized_keys") suggestion = "Remove fields not declared in the onboarding configuration contract.";
      add(`schema_${issue.code}`, path, "This field does not match the onboarding configuration contract.", suggestion);
    }
    return { success: false, issues };
  }

  const configuration = parsed.data;
  const icp = configuration.icp_config;
  const checkText = (value: string, path: string) => {
    if (!value.trim()) add("blank_value", path, "Targeting values must not be blank.", "Provide a meaningful value from the confirmed draft, or use null for an optional targeting list.");
  };
  const checkList = (values: string[] | null, path: string) => {
    const seen = new Set<string>();
    values?.forEach((value, index) => {
      checkText(value, `${path}/${index}`);
      const normalized = normalize(value);
      if (seen.has(normalized)) add("duplicate_value", `${path}/${index}`, "This targeting list contains duplicate values.", "Remove repeated values while preserving the confirmed targeting.");
      seen.add(normalized);
    });
  };
  checkText(icp.label, "/configuration/icp_config/label");
  for (const field of ["person_locations", "organization_industries", "person_seniorities", "organization_num_employees_ranges"] as const) {
    checkList(icp[field], `/configuration/icp_config/${field}`);
  }
  icp.person_seniorities?.forEach((value, index) => {
    if (!SENIORITIES.has(value)) add("unsupported_seniority", `/configuration/icp_config/person_seniorities/${index}`,
      "This seniority is not supported by Apollo.", "Use owner, founder, c_suite, partner, vp, head, director or manager; use null when seniority is not required.");
  });
  icp.organization_num_employees_ranges?.forEach((range, index) => {
    const [floor, ceiling] = range.split(",");
    if (!Number.isSafeInteger(Number(floor)) || (ceiling !== "" && (!Number.isSafeInteger(Number(ceiling)) || Number(ceiling) < Number(floor)))) {
      add("invalid_employee_bounds", `/configuration/icp_config/organization_num_employees_ranges/${index}`,
        "Employee range bounds must be safe integers with minimum at most maximum.", "Correct the numeric bounds; leave the value after the comma empty for an open upper bound.");
    }
  });
  const names = new Set<string>();
  icp.personas.forEach((persona, index) => {
    checkText(persona.name, `/configuration/icp_config/personas/${index}/name`);
    checkList(persona.titles, `/configuration/icp_config/personas/${index}/titles`);
    if (names.has(normalize(persona.name))) add("duplicate_persona", `/configuration/icp_config/personas/${index}/name`,
      "Each confirmed persona must appear exactly once.", "Remove duplicate personas and preserve the names from draft.personas exactly.");
    names.add(normalize(persona.name));
  });
  const personas = DraftPersonas.safeParse(draft.personas);
  if (!personas.success) {
    add("draft_personas_invalid", "/draft/personas", "The confirmed personas cannot be validated.", "Provide the confirmed draft personas, each with a nonempty name and a nonempty titles array.");
  } else {
    const actual = new Map(icp.personas.map((persona) => [persona.name, persona]));
    if (icp.personas.length !== personas.data.length || actual.size !== icp.personas.length || personas.data.some((persona) => !actual.has(persona.name))) {
      add("persona_set_mismatch", "/configuration/icp_config/personas", "Generated personas do not match the confirmed draft.", "Use exactly one persona per draft.personas entry and copy each name verbatim without additions or removals.");
    }
    for (const persona of personas.data) {
      const index = icp.personas.findIndex((item) => item.name === persona.name);
      if (index < 0) continue;
      const titles = new Set(actual.get(persona.name)?.titles.map(normalize));
      if (persona.titles.some((title) => !titles.has(normalize(title)))) {
        add("confirmed_titles_missing", `/configuration/icp_config/personas/${index}/titles`, "The generated persona omits titles confirmed in the draft.", "Restore every title from the corresponding draft persona; additional precise synonyms may be retained.");
      }
    }
  }
  const headings = configuration.scout_overlay.split(/\r?\n/).map((line) => line.trim()).filter((line) => HEADINGS.includes(line));
  if (headings.length !== HEADINGS.length || headings.some((heading, index) => heading !== HEADINGS[index])) {
    add("overlay_sections_invalid", "/configuration/scout_overlay", "The Scout overlay is missing or reorders required sections.", "Include these headings exactly once in order: ## ICP gate; ## Hard disqualifiers; ## Size gate; ## Tier definitions.");
  }
  if (configuration.scout_overlay.length > 52_000) add("overlay_too_large", "/configuration/scout_overlay", "The Scout overlay exceeds the 52,000 character budget.", "Shorten the overlay to at most 52,000 characters; aim for 2,000–4,000 characters and retain the confirmed targeting rules.");
  if (scoutGlobalBase?.trim() && configuration.scout_overlay.includes(scoutGlobalBase.trim())) add("global_base_copied", "/configuration/scout_overlay", "The overlay repeats the server's global Scout instructions.", "Remove the copied global Scout base and keep only the workspace-specific targeting rules in the overlay.");
  return issues.length ? { success: false, issues } : { success: true, configuration };
}


export const ONBOARDING_GENERATION_RULES = [
  "Generate configuration locally from the founder-confirmed draft. Return only the fields in configuration_schema.",
  "Copy contract_version and context_version from this context unchanged. On ONBOARDING_CONTEXT_STALE, fetch new context and regenerate.",
  "icp_config: copy the exact set of draft persona names, one entry per persona; retain every confirmed title (case-insensitive). Precise title synonyms may be added. No duplicate names or duplicate values within targeting lists.",
  "Use only these Apollo seniorities: owner, founder, c_suite, partner, vp, head, director, manager. person_seniorities and person_locations may be null when unconstrained; do not invent a constraint.",
  "organization_industries and organization_num_employees_ranges must be null or nonempty arrays. Use null for employee ranges when the draft size is not expressed as employees; preserve that size rule in Scout.",
  "Employee ranges use minimum,maximum or minimum, for an open upper bound, with safe nonnegative integers and minimum <= maximum. Targeting values must not be blank.",
  "scout_overlay: 200–52,000 characters (aim for 2,000–4,000), with these headings exactly once in this order: ## ICP gate; ## Hard disqualifiers; ## Size gate; ## Tier definitions.",
  "Include workspace-specific targeting, hard disqualifiers, size rules and A/B/C/non-ICP tiers grounded in the draft. Reference company names are calibration evidence, not an account allowlist.",
  "The server composes the overlay with scout_global_base. Do not copy the global base or override its mandatory instructions.",
  "POST /v1/onboarding validates before publication. On LOCAL_CONFIGURATION_INVALID, repair error.issues at their JSON-pointer paths and push again; do not ask the founder to repair technical fields.",
].join("\n");

export function onboardingRepairIssues(code: string): OnboardingLintIssue[] | undefined {
  if (code === "ONBOARDING_CONTEXT_STALE") return [{ code: "context_stale", path: "/configuration/context_version", message: "The generation context changed.", suggestion: "Fetch /v1/onboarding/context, regenerate against its current rules, and copy the new context_version before pushing again." }];
  if (code === "LOCAL_CONFIGURATION_INVALID") return [{ code: "server_validation_failed", path: "/configuration", message: "The server rejected the local configuration.", suggestion: "Fetch the current configuration schema and generation rules, repair the local configuration, and push again." }];
  if (code === "LOCAL_CONFIGURATION_MISMATCH") return [{ code: "receipt_mismatch", path: "/configuration", message: "The local configuration does not match its receipt.", suggestion: "Fetch current onboarding context and submit the local artifact again." }];
  return undefined;
}
