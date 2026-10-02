import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";

const Ref = z.uuid();
const Version = z.number().int().positive();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Name = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const uniqueRefs = z.array(Ref).min(1).max(500).refine(values => new Set(values).size === values.length);
const DayCount = z.number().int().min(0).max(365);
export const DelaySchema = z.union([z.object({ days: DayCount }).strict(), z.object({ business_days: DayCount }).strict()]);
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("qualified") }).strict(),
  z.object({ kind: z.literal("static"), lead_refs: uniqueRefs }).strict(),
]);
const Entry = z.object({ campaign_ref: Ref, trigger: z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("sent"), campaign_ref: Ref, step: z.number().int().min(1).max(3), after: DelaySchema }).strict(),
  z.object({ type: z.literal("unaccepted"), campaign_ref: Ref, after: z.object({ business_days: DayCount }).strict() }).strict(),
]) }).strict();
export const JourneyGraphSchema = z.object({
  entries: z.array(Entry).max(3),
  stops: z.array(z.enum(["reply", "meeting_booked", "suppression", "manual_stop"])).length(4)
    .refine(values => new Set(values).size === values.length),
}).strict().superRefine((graph, context) => {
  const ids = new Set(graph.entries.map(entry => entry.campaign_ref));
  if (graph.entries.length && graph.entries.filter(entry => entry.trigger.type === "start").length !== 1)
    context.addIssue({ code: "custom", message: "A supported graph has exactly one start entry." });
  if (ids.size > 2 || new Set(graph.entries.map(entry => JSON.stringify(entry))).size !== graph.entries.length)
    context.addIssue({ code: "custom", message: "Use at most two campaigns and unique entry triggers." });
  for (const entry of graph.entries) {
    if (entry.trigger.type !== "start" && (!ids.has(entry.trigger.campaign_ref) || entry.trigger.campaign_ref === entry.campaign_ref))
      context.addIssue({ code: "custom", message: "A dependency must reference another declared campaign." });
  }
});
export const JourneyPolicySchema = z.object({ audience: AudienceSchema, graph: JourneyGraphSchema }).strict();
const Schedule = z.object({ timezone: z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(values => new Set(values).size === values.length),
start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict().refine(value => value.start < value.end, "The local sending window must end after it starts.");
const Step = z.object({ position: z.number().int().min(1).max(5), delay: DelaySchema,
  template: z.object({ subject: text(300).refine(value => !/[\r\n]/.test(value)).optional(), text: text(20000) }).strict().optional(),
}).strict();
const CampaignPolicyFields = z.object({
  steps: z.array(Step).min(1).max(5).describe("Saved sequence owns its count. Current adapters: LinkedIn 1–3 messages after invitation; email 4–5 steps, calendar delays up to 30 days."), compose_mode: z.enum(["generate", "templates"]), instructions: z.string().max(30000),
  schedule: Schedule, profile_version: Version, voice_version: z.number().int().nonnegative(), sender_ids: uniqueRefs,
}).strict();
export const CampaignPolicySchema = CampaignPolicyFields.superRefine((policy, context) => {
  policy.steps.forEach((step, index) => {
    const days = "days" in step.delay ? step.delay.days : step.delay.business_days;
    if (step.position !== index + 1 || (index === 0 ? days !== 0 : days < 1))
      context.addIssue({ code: "custom", path: ["steps", index], message: "Use contiguous positions; first delay is zero and later delays are positive." });
    if ((policy.compose_mode === "templates") !== (step.template !== undefined))
      context.addIssue({ code: "custom", path: ["steps", index, "template"], message: "Templates mode requires each step template; generate mode uses instructions instead." });
  });
});
export function campaignChannelIssues(policy: z.infer<typeof CampaignPolicySchema>, channel: "email" | "linkedin") {
  const issues: string[] = [];
  if (channel === "email" && (policy.steps.length < 4 || policy.steps.length > 5)) issues.push("The current email adapter supports four or five saved steps.");
  if (channel === "linkedin" && policy.steps.length > 3) issues.push("The current LinkedIn adapter supports one to three saved messages after its invitation.");
  for (const step of policy.steps) {
    if (channel === "email" && (!("days" in step.delay) || step.delay.days > 30)) issues.push("The current email adapter supports calendar-day delays up to 30 days.");
    if (step.template && (channel === "email" ? !step.template.subject : step.template.subject !== undefined || step.template.text.length > 3000))
      issues.push(channel === "email" ? "An email template requires a subject." : "LinkedIn templates have text only, at most 3000 characters.");
  }
  return issues;
}
export const JourneyPathSchema = z.object({ journey_ref: Ref }).strict();
export const CampaignPathSchema = z.object({ campaign_ref: Ref }).strict();
export const PageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: Ref.optional() }).strict();
export const CampaignQuerySchema = PageQuerySchema.extend({ journey_ref: Ref.optional(), channel: z.enum(["linkedin", "email"]).optional() }).strict();
export const JourneyCreateSchema = z.object({ name: Name, policy: JourneyPolicySchema }).strict();
export const CampaignCreateSchema = z.object({ name: Name, journey_ref: Ref, channel: z.enum(["linkedin", "email"]), policy: CampaignPolicySchema }).strict()
  .superRefine((value, context) => campaignChannelIssues(value.policy, value.channel).forEach(message => context.addIssue({ code: "custom", path: ["policy"], message })));
export const JourneyDraftSchema = z.object({ expected_version: Version, revision_ref: Ref,
  changes: JourneyPolicySchema.partial().strict().refine(value => Object.keys(value).length > 0),
}).strict();
export const CampaignDraftSchema = z.object({ expected_version: Version, revision_ref: Ref,
  changes: CampaignPolicyFields.partial().strict().refine(value => Object.keys(value).length > 0),
}).strict();
export const ExactRevisionSchema = z.object({ revision_ref: Ref, digest: Digest }).strict();
export const PublishSchema = ExactRevisionSchema.extend({ expected_version: Version }).strict();
export const JourneyActivateSchema = PublishSchema.extend({ campaigns: z.array(ExactRevisionSchema.extend({ campaign_ref: Ref }).strict()).min(1).max(2)
  .refine(values => new Set(values.map(value => value.campaign_ref)).size === values.length) }).strict();
export const CampaignActivateSchema = PublishSchema.extend({ expected_journey_version: Version }).strict();
export const CampaignPauseSchema = z.object({ expected_version: Version }).strict();
const Approval = z.object({ actor_ref: Ref, approved_at: Timestamp }).strict();
const revision = <T extends z.ZodType>(content: T) => ExactRevisionSchema.extend({ content, created_at: Timestamp, approval: Approval.nullable() }).strict();
export const JourneyRevisionSchema = revision(JourneyPolicySchema);
export const CampaignRevisionSchema = revision(CampaignPolicySchema);
export const BindingSchema = z.object({ binding_ref: Ref, digest: Digest, journey: ExactRevisionSchema,
  campaigns: z.array(z.object({ campaign_ref: Ref, revision: ExactRevisionSchema }).strict()).min(1).max(2)
    .refine(values => new Set(values.map(value => value.campaign_ref)).size === values.length),
}).strict();
export const JourneySchema = z.object({ journey_ref: Ref, version: Version, name: Name, active_binding: BindingSchema.nullable(),
  draft_revision: JourneyRevisionSchema, revisions: z.array(JourneyRevisionSchema).max(100),
}).strict();
export const CampaignSchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: z.enum(["active", "paused"]), effective_revision: CampaignRevisionSchema.nullable(),
  draft_revision: CampaignRevisionSchema, revisions: z.array(CampaignRevisionSchema).max(100),
}).strict().superRefine((value, context) => {
  for (const rev of [value.draft_revision, ...value.revisions, ...(value.effective_revision ? [value.effective_revision] : [])])
    for (const message of campaignChannelIssues(rev.content, value.channel)) context.addIssue({ code: "custom", message });
});
const Workspace = { workspace: WorkspaceIdentitySchema };
export const JourneyResultSchema = z.object({ ...Workspace, journey: JourneySchema }).strict();
export const CampaignResultSchema = z.object({ ...Workspace, campaign: CampaignSchema }).strict();
export const RevisionSummarySchema = ExactRevisionSchema.extend({ approval: Approval.nullable() }).strict();
export const JourneySummarySchema = z.object({ journey_ref: Ref, version: Version, name: Name, active_binding: BindingSchema.nullable(), draft_revision: RevisionSummarySchema }).strict();
export const CampaignSummarySchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: z.enum(["active", "paused"]), effective_revision: RevisionSummarySchema.nullable(), draft_revision: RevisionSummarySchema }).strict();
export const JourneysSchema = z.object({ ...Workspace, journeys: z.array(JourneySummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
export const CampaignsSchema = z.object({ ...Workspace, campaigns: z.array(CampaignSummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
export const CampaignActivationResultSchema = CampaignResultSchema.extend({ journey: JourneySchema }).strict();
export type JourneyPolicy = z.infer<typeof JourneyPolicySchema>;
export type CampaignPolicy = z.infer<typeof CampaignPolicySchema>;
