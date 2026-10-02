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
export const StopsSchema = z.array(z.enum(["reply", "meeting_booked", "suppression", "manual_stop"])).length(4)
  .refine(values => new Set(values).size === values.length, "Keep all four shared stops.");
export const JourneyPolicySchema = z.object({ audience: AudienceSchema, stops: StopsSchema }).strict();
// Alternatives: the first condition due starts the Campaign once.
const StartCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("journey_start") }).strict(),
  z.object({ type: z.literal("sent"), campaign_ref: Ref, step: z.number().int().min(1).max(10), after: DelaySchema }).strict(),
  z.object({ type: z.literal("unaccepted"), campaign_ref: Ref, after: z.object({ business_days: DayCount }).strict() }).strict(),
]);
export const StartSchema = z.array(StartCondition).min(1).max(3).superRefine((conditions, context) => {
  if (new Set(conditions.map(condition => JSON.stringify(condition))).size !== conditions.length)
    context.addIssue({ code: "custom", message: "Use distinct start conditions." });
  if (conditions.some(condition => condition.type === "journey_start") && conditions.length !== 1)
    context.addIssue({ code: "custom", message: "journey_start is the only condition of a Campaign that starts the Journey." });
});
const Schedule = z.object({ timezone: z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(values => new Set(values).size === values.length),
start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict().refine(value => value.start < value.end, "The local sending window must end after it starts.");
const LaneName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Subject = text(300).refine(value => !/[\r\n]/.test(value));
const Template = z.object({ subject: Subject.optional(), text: text(20000) }).strict();
const Variant = Template.extend({ lane: LaneName.optional(), opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict();
const Step = z.object({ position: z.number().int().min(1).max(5), delay: DelaySchema,
  template: Template.optional(), variants: z.array(Variant).min(1).max(40).optional(),
}).strict();
// Deterministic content lanes: the lead's title picks the first rule whose
// terms it contains, otherwise (including a missing title) the default lane.
export const LanesSchema = z.object({ field: z.literal("title"), default: LaneName,
  rules: z.array(z.object({ lane: LaneName, contains_any: z.array(z.string().trim().min(1).max(60)).min(1).max(20) }).strict()).min(1).max(10),
}).strict().superRefine((lanes, context) => {
  const names = lanes.rules.map(rule => rule.lane);
  if (new Set(names).size !== names.length || names.includes(lanes.default))
    context.addIssue({ code: "custom", message: "Use each lane in one rule and a different default lane." });
});
const CampaignPolicyFields = z.object({
  start: StartSchema,
  steps: z.array(Step).min(1).max(5).describe("The saved sequence owns its count. Executable adapter: LinkedIn invitation then 1–3 messages; email 4–5 steps with calendar delays up to 30 days."),
  compose_mode: z.enum(["generate", "templates"]), instructions: z.string().max(30000), lanes: LanesSchema.optional(),
  schedule: Schedule, profile_version: Version, voice_version: z.number().int().nonnegative(), sender_ids: uniqueRefs,
}).strict();
function laneNames(lanes: z.infer<typeof LanesSchema> | undefined): Array<string | undefined> {
  return lanes ? [...new Set([...lanes.rules.map(rule => rule.lane), lanes.default])] : [undefined];
}
export const CampaignPolicySchema = CampaignPolicyFields.superRefine((policy, context) => {
  if (policy.lanes && policy.compose_mode !== "templates")
    context.addIssue({ code: "custom", path: ["lanes"], message: "Content lanes route saved templates." });
  policy.steps.forEach((step, index) => {
    const days = "days" in step.delay ? step.delay.days : step.delay.business_days;
    if (step.position !== index + 1 || (index === 0 ? days !== 0 : days < 1))
      context.addIssue({ code: "custom", path: ["steps", index], message: "Use contiguous positions; the first delay is zero and later delays are positive." });
    const templated = step.template !== undefined || step.variants !== undefined;
    if ((policy.compose_mode === "templates") !== templated || (step.template !== undefined && step.variants !== undefined))
      context.addIssue({ code: "custom", path: ["steps", index], message: "Templates mode saves one template or its variants per step; generate mode uses instructions." });
    if (step.template && policy.lanes)
      context.addIssue({ code: "custom", path: ["steps", index, "template"], message: "Campaigns with content lanes save one variant per lane." });
    if (step.variants) {
      const openers = step.variants.some(variant => variant.opener) ? ["cold", "linkedin_bridge"] : [undefined];
      if (openers[0] && index !== 0)
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Only the first email has cold and linkedin_bridge openers." });
      if (!policy.lanes && !openers[0])
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Variants require content lanes or first-email openers." });
      const expected = laneNames(policy.lanes).flatMap(lane => openers.map(opener => `${lane ?? ""}|${opener ?? ""}`));
      const keys = step.variants.map(variant => `${variant.lane ?? ""}|${variant.opener ?? ""}`);
      if (keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some(key => !expected.includes(key)))
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Save exactly one variant for every lane and opener." });
    }
  });
});
export function campaignChannelIssues(policy: z.infer<typeof CampaignPolicySchema>, channel: "email" | "linkedin") {
  const issues: string[] = [];
  if (channel === "email" && (policy.steps.length < 4 || policy.steps.length > 5)) issues.push("The executable adapter supports four or five saved emails.");
  if (channel === "linkedin" && policy.steps.length > 3) issues.push("The executable adapter supports one to three saved LinkedIn messages after the invitation.");
  for (const step of policy.steps) {
    if (channel === "email" && (!("days" in step.delay) || step.delay.days > 30)) issues.push("Email delays are calendar days, up to 30.");
    for (const template of [step.template, ...(step.variants ?? [])]) {
      if (!template) continue;
      if (channel === "email" && (step.position === 1) !== (template.subject !== undefined))
        issues.push("An email thread has one subject: the first email's. Later emails reply in the thread.");
      if (channel === "linkedin" && (template.subject !== undefined || template.text.length > 3000))
        issues.push("LinkedIn templates have text only, at most 3000 characters.");
    }
    if (channel === "email" && step.position === 1 && step.variants) {
      for (const lane of laneNames(policy.lanes)) {
        if (new Set(step.variants.filter(variant => variant.lane === lane).map(variant => variant.subject)).size > 1)
          issues.push("Both openers of a lane start the same thread: use one subject per lane.");
      }
    }
  }
  return [...new Set(issues)];
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
  changes: CampaignPolicyFields.extend({ lanes: LanesSchema.nullable() }).partial().strict().refine(value => Object.keys(value).length > 0),
}).strict();
export const ExactRevisionSchema = z.object({ revision_ref: Ref, digest: Digest }).strict();
export const PublishSchema = ExactRevisionSchema.extend({ expected_version: Version }).strict();
export const ActivateSchema = PublishSchema;
export const CampaignPauseSchema = z.object({ expected_version: Version }).strict();
const Approval = z.object({ actor_ref: Ref, approved_at: Timestamp }).strict();
const revision = <T extends z.ZodType>(content: T) => ExactRevisionSchema.extend({ content, created_at: Timestamp, approval: Approval.nullable() }).strict();
export const JourneyRevisionSchema = revision(JourneyPolicySchema);
export const CampaignRevisionSchema = revision(CampaignPolicySchema);
export const RevisionSummarySchema = ExactRevisionSchema.extend({ approval: Approval.nullable() }).strict();
// One executable Journey version: the exact sources selected for new Journey
// starts and whether its automatically derived graph is installed.
export const ExecutableVersionSchema = z.object({ executable_version_ref: Ref, digest: Digest, created_at: Timestamp,
  journey: ExactRevisionSchema,
  campaigns: z.array(z.object({ campaign_ref: Ref, channel: z.enum(["email", "linkedin"]), revision: ExactRevisionSchema }).strict()).min(1).max(2)
    .refine(values => new Set(values.map(value => value.campaign_ref)).size === values.length),
  graph: z.object({ status: z.enum(["compiling", "compiled"]) }).strict(),
}).strict();
const CampaignState = z.enum(["inactive", "active", "paused"]);
export const CampaignSummarySchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: CampaignState, active_revision: RevisionSummarySchema.nullable(), draft_revision: RevisionSummarySchema }).strict();
export const JourneySchema = z.object({ journey_ref: Ref, version: Version, name: Name,
  active_revision: JourneyRevisionSchema.nullable(), draft_revision: JourneyRevisionSchema, revisions: z.array(JourneyRevisionSchema).max(100),
  campaigns: z.array(CampaignSummarySchema).max(100), executable_version: ExecutableVersionSchema.nullable(),
}).strict();
export const CampaignSchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: CampaignState, active_revision: CampaignRevisionSchema.nullable(),
  draft_revision: CampaignRevisionSchema, revisions: z.array(CampaignRevisionSchema).max(100),
}).strict().superRefine((value, context) => {
  for (const rev of [value.draft_revision, ...value.revisions, ...(value.active_revision ? [value.active_revision] : [])])
    for (const message of campaignChannelIssues(rev.content, value.channel)) context.addIssue({ code: "custom", message });
  if (value.state !== "inactive" && !value.active_revision) context.addIssue({ code: "custom", message: "An activated Campaign has a selected revision." });
});
const Workspace = { workspace: WorkspaceIdentitySchema };
export const JourneyResultSchema = z.object({ ...Workspace, journey: JourneySchema }).strict();
export const CampaignResultSchema = z.object({ ...Workspace, campaign: CampaignSchema }).strict();
export const JourneySummarySchema = z.object({ journey_ref: Ref, version: Version, name: Name, active_revision: RevisionSummarySchema.nullable(),
  draft_revision: RevisionSummarySchema, executable_version: ExecutableVersionSchema.nullable() }).strict();
export const JourneysSchema = z.object({ ...Workspace, journeys: z.array(JourneySummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
export const CampaignsSchema = z.object({ ...Workspace, campaigns: z.array(CampaignSummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
export const CampaignActivationResultSchema = CampaignResultSchema.extend({ journey: JourneySchema }).strict();
export type JourneyPolicy = z.infer<typeof JourneyPolicySchema>;
export type CampaignPolicy = z.infer<typeof CampaignPolicySchema>;

export const CampaignTestCreateSchema = PublishSchema.extend({ request_ref: Ref,
  sample: z.union([z.object({ lead_refs: z.array(Ref).min(1).max(20).refine(values => new Set(values).size === values.length),
    opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict(),
    z.object({ baseline_test_ref: Ref, opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict()]),
}).strict();
export const CampaignTestPathSchema = CampaignPathSchema.extend({ test_ref: Ref }).strict();
const TestSummary = z.object({ test_ref: Ref, request_ref: Ref, campaign_ref: Ref, revision_ref: Ref, digest: Digest,
  baseline_test_ref: Ref.nullable(), status: z.enum(["queued", "running", "completed", "failed"]), created_at: Timestamp,
}).strict();
const Selection = z.object({ lane: z.string().nullable(), opener: z.enum(["cold", "linkedin_bridge"]).nullable(),
  template_ids: z.array(z.string().min(1).max(100)).min(1).max(5).optional() }).strict();
const TestOutput = z.object({ output_ref: Ref, digest: Digest, created_at: Timestamp,
  content: z.union([z.object({ linkedin_messages: z.array(z.object({ text: text(3000) }).strict()).min(1).max(3) }).strict(),
    z.object({ email_steps: z.array(z.object({ subject: text(300), text: text(20000), delay_minutes: z.number().int().min(0).max(43200) }).strict()).min(4).max(5) }).strict()]),
  selection: Selection,
  context: z.object({ revision_ref: Ref, digest: Digest, profile_version: Version, voice_version: z.number().int().nonnegative(),
    sender_id: Ref, sender_version: Version, prompt_digest: Digest }).strict(),
}).strict();
export const TestChangeSchema = z.enum(["research_changed", "lead_facts_changed", "sender_changed", "business_changed", "composition_context_changed"]);
export const CampaignTestSchema = TestSummary.extend({ samples: z.array(z.object({ lead_ref: Ref, lab_run_ref: Ref,
  status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]), lane: z.string().nullable(), opener: z.enum(["cold", "linkedin_bridge"]).nullable(),
  output: TestOutput.nullable(), baseline_output: TestOutput.nullable(), changes: z.array(TestChangeSchema),
}).strict()).min(1).max(20) }).strict();
export const CampaignTestResultSchema = z.object({ ...Workspace, test: CampaignTestSchema }).strict();
export const CampaignTestsSchema = z.object({ ...Workspace, tests: z.array(TestSummary).max(100), next_cursor: Ref.nullable() }).strict();

export const CampaignMessagePathSchema = z.object({ message_ref: Ref }).strict();
export const CampaignMessageReviseSchema = z.object({ request_ref: Ref, source_digest: Digest,
  expected_review_status: z.enum(["pending", "enroll_failed"]), changes: z.union([
    z.object({ text: text(3000) }).strict(),
    z.object({ steps: z.array(z.object({ position: z.number().int().min(1).max(6), subject: text(300).refine(value => !/[\r\n]/.test(value)).optional(), text: text(20000) }).strict()).min(1).max(6).refine(steps => new Set(steps.map(step => step.position)).size === steps.length) }).strict(),
  ]),
}).strict();
export const CampaignMessageSchema = z.object({ message_ref: Ref, lead_ref: Ref, channel: z.enum(["email", "linkedin"]),
  status: z.string().nullable(), review_status: z.string().nullable(), is_draft: z.boolean().nullable(), content: z.string(),
  steps: z.array(z.object({ position: z.number().int().positive(), subject: z.string(), text: z.string() }).strict()).nullable(),
  source_message_ref: Ref.nullable(), sender_id: Ref.nullable(), sender_version: Version.nullable(), source_digest: Digest, created_at: Timestamp,
}).strict();
export const CampaignMessageResultSchema = z.object({ ...Workspace, message: CampaignMessageSchema }).strict();
export const CampaignRuntimeSchema = z.object({ ...Workspace, campaign_ref: Ref, intent_active: z.boolean(),
  executable_versions: z.array(z.object({ executable_version_ref: Ref, revision_ref: Ref, started_journeys: z.number().int().nonnegative(),
    continuing_journeys: z.number().int().nonnegative(), prepared_journeys: z.number().int().nonnegative(), pending_journeys: z.number().int().nonnegative(),
    recorded_gate_reasons: z.array(z.object({ reason: z.enum(["delay_pending", "schedule_pending", "delivery_slot_pending", "intent_paused", "recorded_gate_pending", "composition_held"]), count: z.number().int().positive() }).strict()),
  }).strict()),
}).strict();
