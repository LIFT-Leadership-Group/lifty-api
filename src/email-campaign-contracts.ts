import { z } from "zod";
import { EmailConnectRequest } from "./email-contracts.js";

const workspace = EmailConnectRequest.shape.workspace;
const reference = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const campaign = { workspace, campaign_ref: reference };
const step = z.object({
  subject: z.string().min(1).max(300).regex(/^[^\r\n]+$/),
  text: z.string().min(1).max(20000),
  delay_minutes: z.number().int().min(0).max(43200),
}).strict();
const request = <T extends z.ZodRawShape, O extends string>(operation: O, shape: T) =>
  z.object({ operation: z.literal(operation), payload: z.object(shape).strict() }).strict();
export const EmailCampaignRequest = z.discriminatedUnion("operation", [
  request("target", { workspace, email: z.email().max(254).transform(value => value.toLowerCase()), first_name: z.string().trim().max(200).optional(), last_name: z.string().trim().max(200).optional() }),
  request("prepare", { workspace, campaign_ref: reference.optional(), lead_ref: reference, connection_ref: reference, name: z.string().min(1).max(200), steps: z.array(step).min(1).max(5).refine(steps => steps.slice(1).every(item => item.delay_minutes >= 1)), start_at: z.iso.datetime({ offset: true }) }),
  request("preview", campaign),
  request("status", campaign),
  request("approve", { ...campaign, digest }),
  request("activate", { ...campaign, digest }),
  request("pause", campaign),
  request("placement", { ...campaign, digest }),
  request("placement-status", { ...campaign, digest }),
  request("placement-confirm", { ...campaign, digest, placement_ref: reference, test_ref: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), seed_count: z.number().int().min(1).max(10), confirm_seeds: z.literal(true) }),
  request("suppress", { workspace, lead_ref: reference }),
  request("provider", { workspace, channel: z.enum(["email", "linkedin"]), provider: z.enum(["unipile", "smartlead", "heyreach"]) }),
]);
export type EmailCampaignInput = z.infer<typeof EmailCampaignRequest>;

const state = z.enum(["draft", "approved", "active", "paused", "completed", "replied", "suppressed"]);
export const EmailCampaignPreview = z.object({
  campaign_ref: reference, workspace_ref: reference, state, version_ref: reference, digest,
  content: z.object({
    name: z.string().max(200), connection_ref: reference, provider: z.enum(["unipile", "smartlead"]), sender_email: z.email(),
    lead_ref: reference, recipient_email: z.email(), start_at: z.string(), daily_limit: z.literal(10), stop_on_reply: z.literal(true),
    steps: z.array(step).min(1).max(5),
  }),
  approved: z.boolean(), mailbox_use: z.enum(["personal", "outreach"]).nullable(), blockers: z.array(z.string().regex(/^email_[a-z_]+$/)),
  execution_ref: reference.nullable(), execution_state: z.enum(["active", "paused", "completed", "replied", "suppressed", "superseded"]).nullable(),
  steps: z.array(z.object({ step_ref: reference, position: z.number().int().min(1).max(5), state: z.enum(["pending", "accepted", "canceled"]), due_at: z.string().nullable(), intent_ref: reference.nullable(), accepted_at: z.string().nullable() })),
  replies: z.array(z.object({ message_ref: reference, received_at: z.string() })),
});
const PlacementReason = z.enum(["seed_batch_exceeds_daily_limit", "seed_confirmation_required", "workspace_suspended", "campaign_changed", "sender_disconnected", "confirmation_expired", "provider_unavailable", "ambiguous", "invalid_response", "provider_rejected", "insufficient_credits"]);
export const EmailPlacementResult = z.object({
  workspace_ref: reference, campaign_ref: reference, digest, placement_ref: reference,
  status: z.enum(["queued", "running", "completed", "failed", "awaiting_confirmation", "ambiguous", "blocked", "ready"]),
  passed: z.boolean().nullable(), seed_count: z.number().int().min(0).nullable(),
  test_ref: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).nullable().optional(),
  reason: PlacementReason.nullable().optional(),
});
export const EmailCampaignResult = z.union([
  EmailCampaignPreview,
  EmailPlacementResult,
  z.object({ lead_ref: reference, email: z.email(), workspace_ref: reference }),
  z.object({ workspace_ref: reference, channel: z.enum(["email", "linkedin"]), provider: z.enum(["unipile", "smartlead", "heyreach"]), existing_executions_unchanged: z.literal(true) }),
  z.object({ suppressed: z.literal(true), lead_ref: reference }),
]);
export type EmailCampaignOutput = z.infer<typeof EmailCampaignResult>;
export function campaignResultFor(operation: EmailCampaignInput["operation"], data: unknown): EmailCampaignOutput {
  if (["placement", "placement-status", "placement-confirm"].includes(operation) && data && typeof data === "object" && !Array.isArray(data)) {
    const raw = data as Record<string, unknown>;
    if (raw.reason !== null && raw.reason !== undefined && !PlacementReason.safeParse(raw.reason).success) {
      const {reason: _reason, ...safe} = raw;
      data = safe;
    }
  }
  const result = EmailCampaignResult.parse(data);
  const matches = ["placement", "placement-status", "placement-confirm"].includes(operation) ? "placement_ref" in result : operation === "target" ? "email" in result : operation === "provider" ? "existing_executions_unchanged" in result : operation === "suppress" ? "suppressed" in result : "content" in result;
  if (!matches) throw new Error("Invalid campaign operation response.");
  return result;
}
