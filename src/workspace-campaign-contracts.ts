import { z } from "zod";

const ref = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const copy = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const message = z.object({ text: copy(3000) }).strict();
const email = z.object({ subject: copy(300).refine(value => !/[\r\n]/.test(value)), text: copy(20000) }).strict();
export const WorkspaceSequenceInput = z.object({
  name: z.string().trim().min(1).max(200),
  linkedin: z.object({ connection_ref: ref, messages: z.array(message).length(3) }).strict().optional(),
  email: z.object({ connection_ref: ref, steps: z.array(email).length(5) }).strict().optional(),
  // Omission covers current and future qualified A/B leads; an explicit list
  // is a narrower founder choice, never an onboarding questionnaire.
  lead_ids: z.array(ref).min(1).max(500).refine(ids => new Set(ids).size === ids.length).optional(),
  not_before: z.iso.datetime({ offset: true }).optional(),
}).strict().refine(value => value.linkedin !== undefined || value.email !== undefined);
const locator = z.object({ workspace: ref }).strict();
export const WorkspaceCampaignRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.enum(["status", "preview"]), payload: locator }).strict(),
  z.object({ operation: z.literal("prepare"), payload: locator.extend({ configuration: WorkspaceSequenceInput }).strict() }).strict(),
  z.object({ operation: z.enum(["activate", "pause"]), payload: locator.extend({ version_ref: ref, digest, confirm: z.literal(true) }).strict() }).strict(),
]);
const WorkspaceConfiguration = z.object({
    name: z.string(), audience: z.object({ policy: z.literal("qualified_ab_v1"), lead_ids: z.array(ref).nullable(), includes_future_leads: z.boolean() }).strict(),
    linkedin: z.object({ connection_ref: ref, sender: z.string(), timezone: z.string(), messages: z.array(message).length(3), invitation_note: z.null(), delays_business_days: z.tuple([z.literal(0), z.literal(4), z.literal(5)]) }).strict().nullable(),
    email: z.object({ connection_ref: ref, sender: z.string(), steps: z.array(email).length(5), delays_days: z.tuple([z.literal(0), z.literal(3), z.literal(4), z.literal(4), z.literal(4)]) }).strict().nullable(),
    email_entry: z.enum(["after_5_business_days_without_acceptance_or_second_linkedin_message", "direct", "disabled"]),
    not_before: z.string().nullable(),
    personalization_fields: z.array(z.enum(["first_name", "last_name", "company_name"])),
    stop_on_reply: z.literal(true),
    graph: z.record(z.string(), z.unknown()),
  }).strict();
export const WorkspaceCampaignResult = z.object({
  workspace_ref: ref,
  state: z.enum(["unconfigured", "draft", "active", "paused"]),
  outreach_enabled: z.boolean(),
  version_ref: ref.nullable(), digest: digest.nullable(),
  configuration: WorkspaceConfiguration.nullable(),
  continuing_versions: z.array(z.object({ version_ref: ref, digest, configuration: WorkspaceConfiguration, enrolled: z.number().int().positive() }).strict()),
  blocked_leads: z.array(z.object({ lead_ref: ref, reason: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }).strict()).max(50),
  eligible_count: z.number().int().nonnegative(),
  progress: z.object({ enrolled: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
  previews: z.array(z.object({ lead_ref: ref, version_ref: ref, name: z.string(), linkedin: z.array(message).nullable(), email: z.array(email).nullable() }).strict()).max(10),
  blockers: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(50),
}).strict();
export type WorkspaceCampaignInput = z.infer<typeof WorkspaceCampaignRequest>;
export type WorkspaceCampaignOutput = z.infer<typeof WorkspaceCampaignResult>;
export function workspaceCampaignResultFor(input: WorkspaceCampaignInput, data: unknown): WorkspaceCampaignOutput {
  const result = WorkspaceCampaignResult.parse(data);
  if (result.workspace_ref !== input.payload.workspace || ("version_ref" in input.payload && (result.version_ref !== input.payload.version_ref || result.digest !== input.payload.digest))) throw new Error("Workspace campaign response identity mismatch.");
  if (input.operation === "activate" && (result.state !== "active" || !result.outreach_enabled || result.blockers.length > 0)) throw new Error("Workspace activation was not confirmed.");
  if (input.operation === "pause" && (result.state !== "paused" || result.outreach_enabled)) throw new Error("Workspace pause was not confirmed.");
  if (input.operation === "prepare" && result.configuration) {
    const requested = input.payload.configuration;
    const saved = result.configuration;
    if (requested.name !== saved.name || JSON.stringify(requested.lead_ids ?? null) !== JSON.stringify(saved.audience.lead_ids)
      || saved.audience.includes_future_leads !== !requested.lead_ids || (requested.not_before ?? null) !== saved.not_before
      || (requested.linkedin ? !saved.linkedin || requested.linkedin.connection_ref !== saved.linkedin.connection_ref || JSON.stringify(requested.linkedin.messages) !== JSON.stringify(saved.linkedin.messages) : saved.linkedin !== null)
      || (requested.email ? !saved.email || requested.email.connection_ref !== saved.email.connection_ref || JSON.stringify(requested.email.steps) !== JSON.stringify(saved.email.steps) : saved.email !== null)) throw new Error("Workspace preparation content mismatch.");
  }
  if (input.operation === "prepare" && (!result.configuration || !result.version_ref || !result.digest)) throw new Error("Workspace preparation was not confirmed.");
  return result;
}
