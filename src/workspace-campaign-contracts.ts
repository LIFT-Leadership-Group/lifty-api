import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { SharedCampaignChanges, SharedCampaignConfiguration, SharedCampaignConfigurationInput, SharedCampaignPreparation,
  type SharedCampaignConfigurationOutput } from "./shared-campaign-contracts.js";

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
export const WorkspaceCampaignConfigureRequest = z.object({ operation: z.literal("configure"), payload: locator.extend({
  configuration: SharedCampaignConfigurationInput, version_ref: ref.optional(), digest: digest.optional(),
}).strict().refine(value => (value.version_ref === undefined) === (value.digest === undefined), {
  message: "Supply both version_ref and digest from the saved campaign, or neither for initial configuration.",
}) }).strict();
export const WorkspaceCampaignModifyRequest = z.object({ operation: z.literal("modify"), payload: locator.extend({
  version_ref: ref, digest, changes: SharedCampaignChanges,
}).strict() }).strict();
export const WorkspaceCampaignRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.enum(["status", "preview"]), payload: locator }).strict(),
  z.object({ operation: z.literal("prepare"), payload: locator.extend({ configuration: WorkspaceSequenceInput }).strict() }).strict(),
  z.object({ operation: z.enum(["activate", "pause"]), payload: locator.extend({ version_ref: ref, digest, confirm: z.literal(true) }).strict() }).strict(),
  WorkspaceCampaignConfigureRequest,
  WorkspaceCampaignModifyRequest,
]);
const LegacyWorkspaceConfiguration = z.object({
    name: z.string(), audience: z.object({ policy: z.literal("qualified_ab_v1"), lead_ids: z.array(ref).nullable(), includes_future_leads: z.boolean() }).strict(),
    linkedin: z.object({ connection_ref: ref, sender: z.string(), timezone: z.string(), messages: z.array(message).length(3), invitation_note: z.null(), delays_business_days: z.tuple([z.literal(0), z.literal(4), z.literal(5)]) }).strict().nullable(),
    email: z.object({ connection_ref: ref, sender: z.string(), steps: z.array(email).length(5), delays_days: z.tuple([z.literal(0), z.literal(3), z.literal(4), z.literal(4), z.literal(4)]) }).strict().nullable(),
    email_entry: z.enum(["after_5_business_days_without_acceptance_or_second_linkedin_message", "direct", "disabled"]),
    not_before: z.string().nullable(),
    personalization_fields: z.array(z.enum(["first_name", "last_name", "company_name"])),
    stop_on_reply: z.literal(true),
    graph: z.record(z.string(), z.unknown()),
  }).strict();
const WorkspaceConfiguration = z.union([SharedCampaignConfiguration, LegacyWorkspaceConfiguration]);
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
  preparation: SharedCampaignPreparation.optional(),
}).strict().superRefine((value, context) => {
  const shared = value.configuration && "engine" in value.configuration;
  if (Boolean(shared) !== (value.preparation !== undefined))
    context.addIssue({ code: "custom", message: "Shared campaigns require preparation state; legacy campaigns omit it." });
  if (shared && value.configuration!.audience.includes_future_leads !== (value.configuration!.audience.lead_ids === null))
    context.addIssue({ code: "custom", message: "Campaign audience policy is inconsistent." });
});
export type WorkspaceCampaignInput = z.infer<typeof WorkspaceCampaignRequest>;
export type WorkspaceCampaignOutput = z.infer<typeof WorkspaceCampaignResult>;
export function workspaceCampaignResultFor(input: WorkspaceCampaignInput, data: unknown, previous?: WorkspaceCampaignOutput): WorkspaceCampaignOutput {
  const result = WorkspaceCampaignResult.parse(data);
  if (result.workspace_ref !== input.payload.workspace || ((input.operation === "activate" || input.operation === "pause") && (result.version_ref !== input.payload.version_ref || result.digest !== input.payload.digest))) throw new Error("Workspace campaign response identity mismatch.");
  if (input.operation === "activate" && (result.state !== "active" || !result.outreach_enabled || result.blockers.length > 0)) throw new Error("Workspace activation was not confirmed.");
  if (input.operation === "pause" && (result.state !== "paused" || result.outreach_enabled)) throw new Error("Workspace pause was not confirmed.");
  if (input.operation === "activate" && result.preparation && result.preparation.state !== "ready") throw new Error("Shared campaign preparation is incomplete.");
  if (input.operation === "prepare" && result.configuration) {
    const requested = input.payload.configuration;
    const saved = result.configuration;
    if ("engine" in saved) throw new Error("Legacy preparation returned a shared campaign.");
    if (requested.name !== saved.name || JSON.stringify(requested.lead_ids ?? null) !== JSON.stringify(saved.audience.lead_ids)
      || saved.audience.includes_future_leads !== !requested.lead_ids || (requested.not_before ?? null) !== saved.not_before
      || (requested.linkedin ? !saved.linkedin || requested.linkedin.connection_ref !== saved.linkedin.connection_ref || JSON.stringify(requested.linkedin.messages) !== JSON.stringify(saved.linkedin.messages) : saved.linkedin !== null)
      || (requested.email ? !saved.email || requested.email.connection_ref !== saved.email.connection_ref || JSON.stringify(requested.email.steps) !== JSON.stringify(saved.email.steps) : saved.email !== null)) throw new Error("Workspace preparation content mismatch.");
  }
  if (input.operation === "prepare" && (!result.configuration || !result.version_ref || !result.digest)) throw new Error("Workspace preparation was not confirmed.");
  if (input.operation === "configure" || input.operation === "modify") {
    const saved = result.configuration;
    if (!saved || !("engine" in saved) || !result.version_ref || !result.digest || !result.preparation) throw new Error("Shared campaign configuration was not confirmed.");
    const sameVersion = result.version_ref === input.payload.version_ref;
    const sameDigest = result.digest === input.payload.digest;
    if (sameVersion !== sameDigest || (!sameVersion && (result.outreach_enabled || result.state === "active"))) throw new Error("Shared campaign update identity is inconsistent.");
    if (previous && sameVersion && !isDeepStrictEqual(previous.configuration, saved)) throw new Error("Shared campaign changed an immutable version.");
    const requested = input.operation === "configure" ? input.payload.configuration : input.payload.changes;
    const mismatch = () => { throw new Error("Shared campaign configuration content mismatch."); };
    if ((requested.name !== undefined && requested.name !== saved.name)
      || (requested.graph !== undefined && !isDeepStrictEqual(requested.graph, saved.graph))
      || (requested.delivery_specs !== undefined && !isDeepStrictEqual(requested.delivery_specs, saved.delivery_specs))) mismatch();
    if (input.operation === "configure" || requested.lead_ids !== undefined) {
      if (!isDeepStrictEqual(requested.lead_ids ?? null, saved.audience.lead_ids) || saved.audience.includes_future_leads !== (requested.lead_ids == null)) mismatch();
    }
    if ((input.operation === "configure" || requested.not_before !== undefined) && (requested.not_before ?? null) !== saved.not_before) mismatch();
    if (input.operation === "configure" && !isDeepStrictEqual(requested.delivery_specs, saved.delivery_specs)) mismatch();
    for (const channel of ["linkedin", "email"] as const) {
      const values = requested[channel];
      if (values === null || (input.operation === "configure" && values === undefined)) { if (saved[channel] !== null) mismatch(); }
      else if (values !== undefined) {
        const actual = saved[channel];
        if (!actual) mismatch();
        for (const [key, value] of Object.entries(values)) {
          if (!isDeepStrictEqual(value === null && key === "template_bank" ? undefined : value, actual![key as keyof typeof actual])) mismatch();
        }
        if (input.operation === "configure" && !isDeepStrictEqual(values.template_bank, actual!.template_bank)) mismatch();
      }
    }
    if (previous && input.operation === "modify") {
      if (previous.workspace_ref !== input.payload.workspace || previous.version_ref !== input.payload.version_ref || previous.digest !== input.payload.digest
        || !previous.configuration || !("engine" in previous.configuration)) throw new Error("Shared campaign previous identity mismatch.");
      verifyPreservedConfiguration(previous.configuration, saved, input.payload.changes);
    }
  }
  return result;
}

function verifyPreservedConfiguration(before: SharedCampaignConfigurationOutput, after: SharedCampaignConfigurationOutput, changes: z.infer<typeof SharedCampaignChanges>) {
  const expected = structuredClone(before);
  for (const property of ["name", "graph", "delivery_specs", "not_before"] as const) {
    if (changes[property] !== undefined) Object.assign(expected, { [property]: changes[property] });
  }
  if (changes.lead_ids !== undefined) expected.audience = { policy: "qualified_ab_v1", lead_ids: changes.lead_ids, includes_future_leads: changes.lead_ids === null };
  for (const channel of ["linkedin", "email"] as const) {
    const update = changes[channel];
    if (update === undefined) continue;
    if (update === null) { expected[channel] = null; continue; }
    // New/replaced connections resolve sender metadata at the database boundary.
    // The caller cannot supply sender/timezone; readback verifies all input fields.
    if (!expected[channel]) {
      Object.assign(expected, { [channel]: after[channel] });
      continue;
    }
    Object.assign(expected[channel]!, update);
    if (update.connection_ref !== undefined && before[channel]?.connection_ref !== update.connection_ref) {
      expected[channel]!.sender = after[channel]!.sender;
      if (channel === "linkedin" && expected.linkedin && after.linkedin) expected.linkedin.timezone = after.linkedin.timezone;
    }
    if (update.template_bank === null) delete expected[channel]!.template_bank;
  }
  if (!isDeepStrictEqual(expected, after)) throw new Error("Shared campaign update changed an unrelated field.");
}
