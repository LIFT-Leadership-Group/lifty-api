import { z } from "zod";
import type { AuthSession } from "./app.js";
import { WorkspaceIdentitySchema } from "./business-contracts.js";
import { PublicError } from "./errors.js";
import { Timestamp } from "./identity-contracts.js";
import { rpcFailure } from "./rpc-errors.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";

// LIF-1477 counting rules: which CRM meetings and deals count as Lifty's in
// Pipeline and Performance. The database owns the rules per selected CRM,
// fills defaults, enforces limits and provider-specific keys, and resolves the
// workspace from the session's x-lifty-workspace header, like Identity. Rules
// never change outreach, funnel stages or alerts.
const Empty = z.object({}).strict();
const Words = z.array(z.string()).describe("Case-insensitive words; a meeting title or deal name containing one does not count.");
export const MeetingRulesSchema = z.object({
  skip_customers: z.boolean().optional().describe("Leave out leads whose company is a current customer."),
  title_excludes: Words.optional(),
  excluded_types: z.array(z.string().nullable()).optional().describe("HubSpot: activity types that do not count; null is no type."),
  excluded_sources: z.array(z.string()).optional().describe("HubSpot: meeting sources that do not count."),
  outcomes: z.record(z.string(), z.enum(["scheduled", "completed", "no_show", "canceled", "excluded"])).optional()
    .describe("HubSpot: what each meeting outcome means; excluded and canceled do not count."),
  skip_declined: z.boolean().optional().describe("Attio: leave out meetings the lead declined."),
  skip_all_day: z.boolean().optional().describe("Attio: leave out all-day events."),
  max_attendees: z.number().int().nullable().optional().describe("Attio: leave out meetings with more attendees; null is no limit."),
  min_minutes: z.number().int().optional().describe("Attio: leave out meetings shorter than this."),
}).strict();
export const DealRulesSchema = z.object({
  title_excludes: Words.optional(),
  excluded_pipelines: z.array(z.string()).optional().describe("HubSpot: pipeline ids whose deals do not count."),
  stages: z.record(z.string(), z.enum(["open", "won", "lost", "excluded"])).optional()
    .describe("Attio: what each stage title means; excluded does not count."),
}).strict();
const Lead = z.object({ id: z.uuid(), name: z.string().nullable(), company: z.string().nullable() }).strict();
const Credit = z.enum(["created", "enriched"]);
const PreviewSchema = z.object({
  meetings: z.array(z.object({
    id: z.string(), lead: Lead, title: z.string().nullable(), booked_at: Timestamp, starts_at: Timestamp.nullable(),
    status: z.enum(["scheduled", "completed", "no_show", "canceled"]), credit: Credit.nullable(),
  }).strict()),
  deals: z.array(z.object({
    id: z.string(), lead: Lead, name: z.string().nullable(), stage: z.string().nullable(), status: z.enum(["open", "won", "lost"]),
    amount: z.number().nullable(), currency: z.string().nullable(), created_at: Timestamp, credit: Credit,
  }).strict()),
}).strict().describe("Only the meetings and deals that count, booked or created in the last 90 days, newest first.");
export const CrmRulesSchema = z.object({
  workspace: WorkspaceIdentitySchema,
  provider: z.enum(["hubspot", "attio"]).nullable(),
  connected: z.boolean(),
  version: z.number().int().nonnegative(),
  updated_at: Timestamp.nullable(),
  updated_by: z.string().nullable(),
  rules: z.object({ meetings: MeetingRulesSchema, deals: DealRulesSchema }).strict().nullable(),
  catalog: z.record(z.string(), z.unknown())
    .describe("Values seen in the CRM to choose from: HubSpot meeting_types, meeting_sources, meeting_outcomes and pipelines; Attio deal_stages. Empty before the first sync."),
  preview: PreviewSchema,
}).strict();
export const CrmRulesPreviewSchema = z.object({ workspace: WorkspaceIdentitySchema, preview: PreviewSchema }).strict();
const Kinds = { meetings: MeetingRulesSchema.optional(), deals: DealRulesSchema.optional() };
export const CrmRulesPreviewRequestSchema = z.object(Kinds).strict();
export const CrmRulesPatchSchema = z.object({ expected_version: z.number().int().nonnegative(), ...Kinds }).strict();

const route = "/v1/workspace/crm/rules";
const invalid = { status: 422, code: "CRM_RULES_INVALID" } as const;
const unavailable = {
  code: "CRM_RULES_UNAVAILABLE",
  message: "The CRM counting rules could not be verified. Read them again; an unknown read is not a default.",
};
export const crmRulesOperationDefinitions = {
  crm: {
    rules_get: {
      method: "GET", route, cli: { operation: "rules" }, rpc: "get_lifty_crm_rules", path: Empty,
      query: Empty, request: null, invalid: { status: 400, code: "INVALID_REQUEST" },
      response: CrmRulesSchema, success: 200, args: () => ({}),
      description: "Read which CRM meetings and deals count as Lifty's in Pipeline and Performance: the selected CRM's saved rules (defaults when never saved, version 0), the values seen in the CRM and the meetings and deals that count now. rules is null without a CRM. Read-only.",
    },
    rules_preview: {
      method: "POST", readOnly: true, route: `${route}/preview`, cli: { operation: "rules-preview" }, rpc: "preview_lifty_crm_rules", path: Empty,
      query: Empty, request: CrmRulesPreviewRequestSchema, invalid, response: CrmRulesPreviewSchema, success: 200,
      args: input => ({ p_payload: input.body }),
      description: "Preview the meetings and deals that would count with the full meetings or deals rules supplied; an omitted kind uses the saved rules. Saves nothing.",
    },
    rules_patch: {
      method: "PATCH", route, cli: { operation: "rules" }, rpc: "patch_lifty_crm_rules", path: Empty,
      query: Empty, request: CrmRulesPatchSchema, invalid, response: CrmRulesSchema, success: 200,
      args: input => ({ p_payload: input.body }),
      description: "Save the full meetings or deals rules with expected_version; missing keys take their defaults and an omitted kind keeps its saved rules. Changes only what Pipeline and Performance count; never changes outreach, CRM records or alerts.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;
export const crmRulesEntries = () => Object.entries(crmRulesOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, definition: definition as IdentityDefinition })));

export async function executeCrmRulesOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown> {
  const entry = crmRulesEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown CRM rules operation");
  const { definition } = entry;
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
    .rpc(definition.rpc, { p_workspace_id: null, ...definition.args(input) }); }
  catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
  if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
  const parsed = definition.response.safeParse(result.data);
  if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
  return parsed.data;
}
