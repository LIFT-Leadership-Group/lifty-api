import { z } from "zod";
import { EmailConnectRequest } from "./email-contracts.js";

export const REQUIRED_WARMUP_ACTIVE_DAYS = 21;

export const WarmupWorkspaceRequest = z.object({
  workspace: EmailConnectRequest.shape.workspace,
  connection_ref: z.uuid().optional(),
}).strict();
export type WarmupWorkspaceInput = z.infer<typeof WarmupWorkspaceRequest>;

export const WarmupOperation = z.enum(["start", "pause", "resume", "remove"]);
export type WarmupOperation = z.infer<typeof WarmupOperation>;

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(1_000_000);

// Session-scoped RPC status object. Parsing strips unknown keys so
// a newer database cannot leak additions (for example provider IDs) outward.
const DbCheck = z.string().max(64).nullish();
export const WarmupSnapshot = z.object({
  status_code: z.string().max(64).nullish(),
  grade: z.string().max(16).nullish(),
  spf: DbCheck, dmarc: DbCheck, mx: DbCheck,
  domain_age: count.nullish(),
  warmup_duration_days: count.nullish(),
  emails_sent_today: count.nullish(),
  outreach_today: count.nullish(),
  response_today: count.nullish(),
  email_per_day_target: count.nullish(),
  connection_problem: z.boolean().nullish(),
});
export const WarmupBindingState = z.enum(["link_issued", "pending_consent", "warming", "paused", "problem", "removed"]);
export const WarmupRequestedAction = z.enum(["pause", "resume", "remove"]);
export const StoredWarmupStatus = z.object({
  workspace_ref: z.uuid(),
  email: z.email().nullable(),
  mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  warmup_required: z.boolean(),
  required_active_days: z.number().int().min(1).max(365),
  binding: z.object({
    binding_ref: z.uuid(), sender_ref: z.uuid(), state: WarmupBindingState,
    requested_action: WarmupRequestedAction.nullable(),
    blocking_reason: z.string().max(64).nullable(),
    provider_campaign_bound: z.boolean(),
    last_readback_at: timestamp.nullable(),
    snapshot: WarmupSnapshot.nullable(),
    created_at: timestamp,
  }).nullable(),
  evidence: z.object({
    active_duration_days: count, healthy: z.boolean(), passed: z.boolean(),
    observed_at: timestamp, fresh: z.boolean(),
  }).nullable(),
  outreach_unlocked: z.boolean().nullable(),
  connection_ref: z.uuid().optional(),
  campaign_send_paused: z.boolean().optional(),
  campaign_release_required: z.literal(true).optional(),
}).refine(value => {
  const fields = [value.connection_ref, value.campaign_send_paused, value.campaign_release_required];
  return fields.every(field => field === undefined) || fields.every(field => field !== undefined);
}, { message: "Client connection status must include campaign release state." });
export type StoredWarmupStatus = z.infer<typeof StoredWarmupStatus>;

// Public founder-facing shape. Strict so older clients fail closed on additions.
export const WarmupState = z.enum(["not_started", ...WarmupBindingState.options]);
const Check = z.enum(["valid", "not_valid", "unknown"]);
export const WarmupGoLive = z.object({
  kind: z.enum(["connect_email", "now", "unlocked", "awaiting_check", "projected", "awaiting_release"]),
  date: z.iso.date().nullable(),
  remaining_active_days: z.number().int().min(0).max(365).nullable(),
  message: z.string().min(1).max(600),
}).strict();
export const WarmupStatus = z.object({
  provider: z.literal("mailivery"),
  workspace_ref: z.uuid(),
  email: z.email().nullable(),
  mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  warmup_required: z.boolean(),
  required_active_days: z.number().int().min(1).max(365),
  state: WarmupState,
  state_label: z.string().min(1).max(120),
  requested_action: WarmupRequestedAction.nullable(),
  blocking_reason: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), message: z.string().min(1).max(300) }).strict().nullable(),
  active_days: z.number().int().min(0).max(100_000),
  today: z.object({ warmup_emails: count.nullable(), ramp_target: count.nullable() }).strict(),
  checks: z.object({ spf: Check, dmarc: Check, mx: Check }).strict(),
  last_checked_at: timestamp.nullable(),
  outreach_unlocked: z.boolean().nullable(),
  recommended_go_live: WarmupGoLive,
  // Present only for an explicitly selected client connection. Founder output is unchanged.
  connection_ref: z.uuid().optional(),
  campaign_send_paused: z.boolean().optional(),
  campaign_release_required: z.literal(true).optional(),
}).strict();
export type WarmupStatus = z.infer<typeof WarmupStatus>;
export const WarmupStartResult = WarmupStatus.extend({
  connect_url: z.url({ protocol: /^https$/ }).nullable(),
  expires_at: timestamp.nullable(),
}).strict();
export type WarmupStartResult = z.infer<typeof WarmupStartResult>;
