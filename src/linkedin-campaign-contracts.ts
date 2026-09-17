import { z } from "zod";
import { LinkedinPolicy, LinkedinTimezone, LinkedinWorkspace } from "./linkedin-contracts.js";

const ref = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// No content transformation: the approval digest binds the exact supplied text.
const text = z.string().min(1).max(3000).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const message = z.object({ text }).strict();
const messages = z.array(message).length(3);
const preparation = z.object({ workspace: LinkedinWorkspace, lead_id: ref, connection_ref: ref, campaign_ref: ref.optional() });
const locator = z.object({ workspace: LinkedinWorkspace, campaign_ref: ref }).strict();
const control = locator.extend({ digest, confirm: z.literal(true) }).strict();
export const LinkedinCampaignRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), payload: z.union([preparation.extend({ text }).strict(), preparation.extend({ messages }).strict()]) }).strict(),
  z.object({ operation: z.enum(["preview", "status"]), payload: locator }).strict(),
  z.object({ operation: z.enum(["approve", "activate", "pause", "cancel"]), payload: control }).strict(),
]);
const contentBase = z.object({ invitation: z.object({ note: z.null() }).strict(),
  target_identifier: z.string().min(1).max(2048), timezone: LinkedinTimezone, policy: LinkedinPolicy });
export const LinkedinCampaignResult = z.object({
  campaign_ref: ref, workspace_ref: ref, connection_ref: ref, lead_id: ref, version_ref: ref, digest,
  state: z.enum(["draft", "approved", "active", "paused", "canceled", "completed", "replied", "suppressed"]), approved: z.boolean(),
  content: z.union([
    contentBase.extend({ message }).strict(),
    contentBase.extend({ messages, message_delays_business_days: z.tuple([z.literal(0), z.literal(4), z.literal(5)]) }).strict(),
  ]),
  actions: z.array(z.object({
    message_position: z.number().int().min(1).max(3).nullable().optional(),
    intent_ref: ref, action_type: z.enum(["connection_request", "message"]),
    status: z.enum(["planned", "approved", "claimed", "succeeded", "failed", "ambiguous", "blocked", "cancelled", "simulated"]),
    provider_id: z.string().max(1024).nullable(), chat_id: z.string().max(1024).nullable(),
    acceptance_detected_at: z.string().nullable(), error_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(),
  }).strict()).max(4),
  blockers: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(50),
}).strict();
export type LinkedinCampaignInput = z.infer<typeof LinkedinCampaignRequest>;
export type LinkedinCampaignOutput = z.infer<typeof LinkedinCampaignResult>;
export function linkedinCampaignResultFor(input: LinkedinCampaignInput, data: unknown): LinkedinCampaignOutput {
  const result = LinkedinCampaignResult.parse(data);
  if (("campaign_ref" in input.payload && input.payload.campaign_ref && input.payload.campaign_ref !== result.campaign_ref)
    || ("digest" in input.payload && input.payload.digest !== result.digest)
    || (z.uuid().safeParse(input.payload.workspace).success && input.payload.workspace !== result.workspace_ref)
    || (input.operation === "prepare" && (input.payload.lead_id !== result.lead_id || input.payload.connection_ref !== result.connection_ref || !("text" in input.payload
      ? "message" in result.content && input.payload.text === result.content.message.text
      : "messages" in result.content && JSON.stringify(input.payload.messages) === JSON.stringify(result.content.messages)))))
    throw new Error("LinkedIn campaign response identity mismatch.");
  if ((input.operation === "approve" && (!result.approved || !["approved", "paused"].includes(result.state)))
    || (input.operation === "activate" && (!result.approved || !["active", "completed"].includes(result.state)))
    || (input.operation === "pause" && result.state !== "paused")
    || (input.operation === "cancel" && (result.state !== "canceled" || result.actions.some(action => ["planned", "approved", "blocked"].includes(action.status)))))
    throw new Error("LinkedIn campaign operation was not confirmed.");
  return result;
}
