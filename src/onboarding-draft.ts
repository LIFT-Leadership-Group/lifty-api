import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { OnboardingLintIssue } from "./generated/lifty-configuration.js";

const currentSchema = JSON.parse(readFileSync(new URL("./agent-context/draft.schema.json", import.meta.url), "utf8"));
const draftSchema = z.fromJSONSchema(currentSchema);
const MeaningfulText = z.string().trim().min(1);
const Semantics = z.object({
  company: z.object({ name: MeaningfulText, description: z.string().trim().min(20), example_companies: z.array(z.string()) }),
  primary_motion: z.object({ name: MeaningfulText, outcome: MeaningfulText }),
  parked_secondary_motions: z.array(z.object({ name: MeaningfulText })),
  icp: z.object({
    industries_in: z.array(z.string()), industries_out: z.array(z.string()), hard_disqualifiers: z.array(z.string()),
    size: z.object({ floor: z.number(), ceiling: z.number().nullable(), unit: z.string() }),
    operating_state_split: z.object({ states: z.array(z.object({ name: z.string(), fit: MeaningfulText })), priority: z.string() }).nullable(),
    discovery: z.object({ person_locations: z.array(z.string()).nullable(), organization_locations: z.array(z.string()).nullable(),
      employee_range_proxy: z.object({ floor: z.number(), ceiling: z.number().nullable() }).nullable(), q_keywords: MeaningfulText.nullable() }),
  }),
  personas: z.array(z.object({ name: MeaningfulText, titles: z.array(z.string()), tell: MeaningfulText })),
  research_findings: z.array(z.object({ field: MeaningfulText, source: MeaningfulText, value: z.unknown(), state: z.string(),
    used_in_configuration: z.boolean(), founder_confirmation: z.string().nullable() })),
  founder_statement_history: z.array(z.object({ sequence: z.number(), field: MeaningfulText, value: z.unknown() })),
});
const configuredRoots = new Set(["company", "primary_motion", "parked_secondary_motions", "icp", "personas", "calibration", "outreach"]);

/** Business and confirmation validation belongs to the API, never a frozen writer. */
export function lintOnboardingDraft(draft: Record<string, unknown>): OnboardingLintIssue[] {
  const issues: OnboardingLintIssue[] = [];
  const add = (code: string, path: string, message: string) => {
    if (issues.length < 20) issues.push({ code, path: `/draft${path}`, message,
      suggestion: "Read the current draft schema and preserve the founder's latest confirmed decisions." });
  };
  const shape = draftSchema.safeParse(draft);
  if (!shape.success) {
    for (const issue of shape.error.issues) add("draft_schema_invalid", `/${issue.path.join("/")}`, "This decision does not match the current onboarding draft schema.");
    return issues;
  }
  const parsed = Semantics.safeParse(draft);
  if (!parsed.success) {
    add("draft_decisions_invalid", "", "Required onboarding decisions are missing or invalid.");
    return issues;
  }
  const value = parsed.data;
  const list = (values: string[], path: string) => {
    const normalized = values.map(item => item.trim().toLowerCase());
    if (normalized.some(item => !item) || new Set(normalized).size !== normalized.length) add("draft_list_invalid", path, "Confirmed lists need distinct nonempty values.");
  };
  list(value.company.example_companies, "/company/example_companies");
  list(value.icp.industries_in, "/icp/industries_in");
  list(value.icp.industries_out, "/icp/industries_out");
  list(value.icp.hard_disqualifiers, "/icp/hard_disqualifiers");
  list(value.icp.discovery.person_locations ?? [], "/icp/discovery/person_locations");
  list(value.icp.discovery.organization_locations ?? [], "/icp/discovery/organization_locations");
  value.personas.forEach((persona, index) => list(persona.titles, `/personas/${index}/titles`));
  if (value.company.name.trim().length < 1 || value.company.description.trim().length < 20) add("draft_company_invalid", "/company", "The business needs a confirmed name and meaningful description.");
  const size = value.icp.size;
  if (!size.unit.trim() || (size.ceiling !== null && size.ceiling < size.floor)) add("draft_size_invalid", "/icp/size", "The size ceiling cannot be below its floor and the unit must be explicit.");
  const proxy = value.icp.discovery.employee_range_proxy;
  if (proxy && (!Number.isSafeInteger(proxy.floor) || (proxy.ceiling !== null && (!Number.isSafeInteger(proxy.ceiling) || proxy.ceiling < proxy.floor)))) add("draft_proxy_invalid", "/icp/discovery/employee_range_proxy", "Use whole employee counts with a ceiling at least the floor.");
  const split = value.icp.operating_state_split;
  if (split) {
    list(split.states.map(item => item.name), "/icp/operating_state_split/states");
    if (!split.states.some(item => item.name.trim().toLowerCase() === split.priority.trim().toLowerCase())) add("draft_priority_invalid", "/icp/operating_state_split/priority", "Priority must name one of the confirmed operating states.");
  }
  const resolve = (field: string): { found: boolean; value?: unknown } => {
    let current: unknown = draft;
    for (const part of field.split(".")) {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return { found: false };
      current = (current as Record<string, unknown>)[part];
    }
    return { found: true, value: current };
  };
  value.research_findings.forEach((finding, index) => {
    const path = `/research_findings/${index}`;
    if (finding.state === "inferred" && (finding.used_in_configuration || finding.founder_confirmation !== null)) add("draft_unconfirmed_research", path, "Inferred research cannot enter configuration or claim founder confirmation.");
    if (finding.state !== "inferred" && !finding.founder_confirmation?.trim()) add("draft_confirmation_missing", path, "Confirmed research requires the founder's confirmation.");
    if (finding.used_in_configuration) {
      const result = resolve(finding.field);
      const [root, ...parts] = finding.field.split(".");
      if (!root || !configuredRoots.has(root) || !parts.length || !result.found || !isDeepStrictEqual(result.value, finding.value)) add("draft_research_mismatch", path, "Confirmed research must match its actual configured field.");
    }
  });
  const latest = new Map<string, { statement: typeof value.founder_statement_history[number]; index: number }>();
  const sequences = new Set<number>();
  value.founder_statement_history.forEach((statement, index) => {
    if (sequences.has(statement.sequence)) add("draft_history_duplicate", `/founder_statement_history/${index}`, "Founder statement sequences must be unique.");
    sequences.add(statement.sequence);
    if (statement.sequence > (latest.get(statement.field)?.statement.sequence ?? 0)) latest.set(statement.field, { statement, index });
  });
  for (const [field, { statement, index }] of latest) {
    const result = resolve(field);
    // Identify the actual array entry (sequence order need not equal index).
    // Reflect only a valid configured path, never the private decision values.
    const safeField = field.length <= 200 && /^(?:[a-z_]+|\d+)(?:\.(?:[a-z_]+|\d+))*$/.test(field)
      && configuredRoots.has(field.split(".")[0]!);
    if (!result.found) add("draft_latest_statement_mismatch", `/founder_statement_history/${index}/field`,
      "This founder statement must name an existing configured decision using its dotted field path.");
    else if (!isDeepStrictEqual(result.value, statement.value)) add("draft_latest_statement_mismatch", `/founder_statement_history/${index}/value`,
      safeField ? `The newest founder statement must match the exact JSON value at /draft/${field.replaceAll(".", "/")}.`
        : "The newest founder statement must match the exact JSON value at its configured field.");
  }
  return issues;
}
