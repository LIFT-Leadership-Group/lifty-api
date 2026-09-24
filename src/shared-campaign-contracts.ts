import { z } from "zod";

const key = z.string().min(1).max(200);
const dayCount = z.number().int().min(0).max(365);
const delay = z.union([
  z.string().regex(/^\d+d$/),
  z.object({ days: dayCount }).strict(),
  z.object({ business_days: dayCount }).strict(),
]);
const trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("event"), event: key }).strict(),
  z.object({ type: z.literal("time"), after: delay, anchor: z.enum(["block_entered", "action_completed"]).optional() }).strict(),
]);

// This is the transport shape of the existing compiled graph, not a second
// execution engine. Jobs validates executable actions and graph semantics and
// pins the shared composition context before preparation can become ready.
export const SharedCampaignGraph = z.object({
  schema_version: z.enum(["journey_graph.v1", "journey_graph.v1.1"]),
  blocks: z.array(z.object({
    key, kind: z.enum(["start", "end", "provider_action", "provider_campaign", "manual", "decision"]),
    label: z.string().max(300).optional(), channel: key.optional(), provider: key.optional(),
    action: key.optional(), delivery_spec_key: key.optional(), terminal_reason: key.optional(),
  }).strict()).min(2).max(100),
  transitions: z.array(z.object({
    key, branch_key: key, from: key, to: key, trigger,
    execute_within: z.object({ business_days: dayCount }).strict().optional(),
    fork: z.boolean().optional(), close: z.enum(["journey", "branch"]).optional(),
    terminal_reason: key.optional(), priority: z.number().int().optional(),
  }).strict()).min(1).max(300),
  stop_policies: z.array(z.object({ event: key, scope: z.enum(["block", "branch", "journey"]), action: key }).strict()).max(100).optional(),
  event_policies: z.array(z.object({ event: key, actions: z.array(key).max(100) }).strict()).max(100).optional(),
  event_registry: z.record(key, z.array(key).max(100)).optional(),
}).strict().superRefine((graph, context) => {
  const blocks = new Map(graph.blocks.map(block => [block.key, block]));
  if (blocks.size !== graph.blocks.length || new Set(graph.transitions.map(t => t.key)).size !== graph.transitions.length)
    context.addIssue({ code: "custom", message: "Graph keys must be unique." });
  if (!graph.blocks.some(block => block.kind === "start") || !graph.blocks.some(block => block.kind === "end"))
    context.addIssue({ code: "custom", message: "Graph requires start and end blocks." });
  for (const transition of graph.transitions) {
    if (!blocks.has(transition.from) || !blocks.has(transition.to))
      context.addIssue({ code: "custom", message: "Graph transition references an unknown block." });
    if (transition.fork && blocks.get(transition.to)?.kind === "end")
      context.addIssue({ code: "custom", message: "A fork cannot enter an end block." });
    if (transition.close !== undefined && blocks.get(transition.to)?.kind !== "end")
      context.addIssue({ code: "custom", message: "Close is only valid on end transitions." });
  }
});

const instruction = z.string().max(30000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
export const SharedCampaignChannel = z.object({
  connection_ref: z.uuid(),
  compose_mode: z.enum(["generate", "templates"]),
  overlay: instruction,
  template_bank: instruction.refine(value => value.trim().length > 0).optional(),
}).strict();
export const SharedCampaignDeliverySpecs = z.record(key, z.object({
  steps: z.array(z.object({ seq_number: z.number().int().min(1).max(5), delay_in_days: z.number().int().min(0).max(30) }).strict()).min(4).max(5)
    .refine(steps => steps.every((step, index) => step.seq_number === index + 1 && (index === 0 ? step.delay_in_days === 0 : step.delay_in_days >= 1))),
}).strict());
const ids = z.array(z.uuid()).min(1).max(500).refine(value => new Set(value).size === value.length);
export const SharedCampaignConfigurationInput = z.object({
  engine: z.literal("shared_v1"), name: z.string().trim().min(1).max(200),
  graph: SharedCampaignGraph,
  delivery_specs: SharedCampaignDeliverySpecs.optional(),
  linkedin: SharedCampaignChannel.optional(), email: SharedCampaignChannel.optional(),
  lead_ids: ids.optional(), not_before: z.iso.datetime({ offset: true }).optional(),
}).strict().refine(value => value.linkedin !== undefined || value.email !== undefined)
  .refine(value => [value.linkedin, value.email].every(channel => !channel || channel.compose_mode !== "generate" || channel.template_bank === undefined));
const channelChanges = SharedCampaignChannel.partial().extend({ template_bank: instruction.refine(value => value.trim().length > 0).nullable().optional() })
  .refine(value => Object.keys(value).length > 0)
  .refine(value => value.compose_mode !== "generate" || value.template_bank == null);
export const SharedCampaignChanges = z.object({
  name: z.string().trim().min(1).max(200).optional(), graph: SharedCampaignGraph.optional(),
  delivery_specs: SharedCampaignDeliverySpecs.optional(),
  linkedin: channelChanges.nullable().optional(), email: channelChanges.nullable().optional(),
  lead_ids: ids.nullable().optional(), not_before: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export const SharedCampaignConfiguration = z.object({
  engine: z.literal("shared_v1"), name: z.string(),
  audience: z.object({ policy: z.literal("qualified_ab_v1"), lead_ids: z.array(z.uuid()).nullable(), includes_future_leads: z.boolean() }).strict(),
  graph: SharedCampaignGraph,
  delivery_specs: SharedCampaignDeliverySpecs.optional(),
  linkedin: SharedCampaignChannel.extend({ sender: z.string(), timezone: z.string(), invitation_note: z.null() }).strict().nullable(),
  email: SharedCampaignChannel.extend({ sender: z.string() }).strict().nullable(),
  not_before: z.string().nullable(), stop_on_reply: z.literal(true),
}).strict().refine(value => value.linkedin !== null || value.email !== null)
  .refine(value => [value.linkedin, value.email].every(channel => !channel || channel.compose_mode !== "generate" || channel.template_bank === undefined));
export const SharedCampaignPreparation = z.object({
  state: z.enum(["pending", "ready", "failed"]), errors: z.array(z.string().max(1000)).max(50),
}).strict().refine(value => value.state !== "ready" || value.errors.length === 0);
export type SharedCampaignConfigurationOutput = z.infer<typeof SharedCampaignConfiguration>;
