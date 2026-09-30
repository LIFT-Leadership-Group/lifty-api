import { z } from "zod";
import { lintOnboardingDraft } from "./onboarding-draft.js";

// The interview's bootstrap decisions, in the order an agent should ask for
// them. Computed from a partial saved draft so the agent never re-derives
// what is missing; `draft_ready` (the full lint) stays the only readiness.
export const INTERVIEW_GATES = ["company", "motion", "market", "exclusions", "boundaries", "persona"] as const;
export type InterviewGate = typeof INTERVIEW_GATES[number];
export const InterviewGatesSchema = z.object({
  next: z.enum(INTERVIEW_GATES).nullable().describe("The one decision to ask for now; null when every gate is done."),
  missing: z.array(z.enum(INTERVIEW_GATES)),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).max(5)
    .describe("Technical draft problems once every gate is done. Fix them without asking the founder."),
}).strict();
export type InterviewGates = z.infer<typeof InterviewGatesSchema>;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown, min = 1) => typeof value === "string" && value.trim().length >= min;
const texts = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(item => text(item));
const nullableTexts = (value: unknown) => value === null || texts(value);
const EMPLOYEE_UNIT = /employee|headcount|\bfte|people|staff/i;

const checks: Record<InterviewGate, (draft: Json) => boolean> = {
  company: draft => { const company = record(draft.company); return !!company && text(company.name) && text(company.description, 20); },
  motion: draft => { const motion = record(draft.primary_motion); return !!motion && text(motion.name) && text(motion.outcome); },
  market: draft => {
    const icp = record(draft.icp); const size = record(icp?.size);
    return !!icp && texts(icp.industries_in) && !!size && typeof size.floor === "number" && size.floor > 0 && text(size.unit);
  },
  exclusions: draft => texts(record(draft.icp)?.hard_disqualifiers),
  boundaries: draft => {
    const icp = record(draft.icp); const discovery = record(icp?.discovery);
    if (!discovery || !["person_locations", "organization_locations", "employee_range_proxy", "q_keywords", "broad_search_confirmed"]
      .every(key => Object.hasOwn(discovery, key))) return false;
    if (!nullableTexts(discovery.person_locations) || !nullableTexts(discovery.organization_locations)
      || typeof discovery.broad_search_confirmed !== "boolean") return false;
    const unit = record(icp?.size)?.unit;
    const employees = typeof unit === "string" && EMPLOYEE_UNIT.test(unit);
    const bounded = discovery.person_locations !== null || discovery.organization_locations !== null
      || discovery.employee_range_proxy !== null || text(discovery.q_keywords) || employees;
    return bounded || discovery.broad_search_confirmed === true;
  },
  persona: draft => Array.isArray(draft.personas) && draft.personas.some(item => {
    const persona = record(item);
    return !!persona && text(persona.name) && (persona.role === "decision_maker" || persona.role === "influencer")
      && texts(persona.titles) && text(persona.tell);
  }),
};

export function interviewGates(draft: unknown): InterviewGates {
  const value = record(draft) ?? {};
  const missing = INTERVIEW_GATES.filter(gate => !checks[gate](value));
  const issues = missing.length ? [] : lintOnboardingDraft(value).slice(0, 5)
    .map(issue => ({ path: issue.path, message: issue.message }));
  return { next: missing[0] ?? null, missing, issues };
}
