import { z } from "zod";
import { EmailWorkspace } from "./email-contracts.js";

export const REQUIRED_WARMUP_ACTIVE_DAYS = 21;

export const WarmupWorkspaceRequest = z.object({
  workspace: EmailWorkspace,
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
// LIF-1228: SQL's spam verdict for the latest measured window of warmup sends.
const StoredWarmupSpam = z.object({
  spam_count: count, sent: count, window_days: z.number().int().min(1).max(14),
  blocking: z.boolean(), warning: z.boolean(), observed_at: timestamp,
});
export const StoredWarmupStatus = z.object({
  workspace_ref: z.uuid(),
  connection_ref: z.uuid().nullable(),
  email: z.email().nullable(),
  mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  warmup_required: z.boolean(),
  required_active_days: z.number().int().min(1).max(365),
  binding: z.object({
    binding_ref: z.uuid(), sender_ref: z.uuid(), state: WarmupBindingState,
    requested_action: WarmupRequestedAction.nullable(),
    user_paused: z.boolean(), connection_paused: z.boolean(),
    blocking_reason: z.string().max(64).nullable(),
    provider_campaign_bound: z.boolean(),
    last_readback_at: timestamp.nullable(),
    snapshot: WarmupSnapshot.nullable(),
    created_at: timestamp,
  }).nullable(),
  evidence: z.object({
    active_duration_days: count, healthy: z.boolean().nullable(), passed: z.boolean(),
    observed_at: timestamp, fresh: z.boolean(),
  }).nullable(),
  warmup_complete: z.boolean(),
  warmup_spam: StoredWarmupSpam.nullable(),
  warmup_blocker: z.enum(["email_warmup_required", "email_warmup_spam"]).nullable(),
  warmup_ready: z.boolean(),
});
export type StoredWarmupStatus = z.infer<typeof StoredWarmupStatus>;

// Public shape. Strict so older clients fail closed on additions. No provider
// identity appears here (LIF-1186 decision 1).
export const WarmupState = z.enum(["not_started", ...WarmupBindingState.options]);
const Check = z.enum(["valid", "not_valid", "unknown"]);
export const WarmupGoLive = z.object({
  kind: z.enum(["connect_email", "now", "unlocked", "awaiting_check", "projected", "held"]),
  date: z.iso.date().nullable(),
  remaining_active_days: z.number().int().min(0).max(365).nullable(),
  message: z.string().min(1).max(600),
}).strict();
export const WarmupSpam = z.object({
  spam_count: count, sent: count, window_days: z.number().int().min(1).max(14),
  holds_sending: z.boolean(), warning: z.boolean(), observed_at: timestamp,
}).strict();
export const WarmupStatus = z.object({
  workspace_ref: z.uuid(),
  connection_ref: z.uuid().nullable(),
  email: z.email().nullable(),
  mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  warmup_required: z.boolean(),
  required_active_days: z.number().int().min(1).max(365),
  state: WarmupState,
  user_paused: z.boolean(), connection_paused: z.boolean(),
  state_label: z.string().min(1).max(120),
  requested_action: WarmupRequestedAction.nullable(),
  blocking_reason: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), message: z.string().min(1).max(300) }).strict().nullable(),
  active_days: z.number().int().min(0).max(100_000),
  today: z.object({ warmup_emails: count.nullable(), ramp_target: count.nullable() }).strict(),
  checks: z.object({ spf: Check, dmarc: Check, mx: Check }).strict(),
  last_checked_at: timestamp.nullable(),
  // A dedicated mailbox's verified initial period (21 active days on a healthy check).
  initial_period_complete: z.boolean(),
  spam: WarmupSpam.nullable(),
  // Warmup's own contribution only: true when warmup does not hold this mailbox.
  // Campaign activation, placement and pauses are separate checks.
  warmup_ready: z.boolean(),
  recommended_go_live: WarmupGoLive,
}).strict();
export type WarmupStatus = z.infer<typeof WarmupStatus>;
export const WarmupStartResult = WarmupStatus.extend({
  connect_url: z.url({ protocol: /^https$/ }).nullable(),
  expires_at: timestamp.nullable(),
}).strict();
export type WarmupStartResult = z.infer<typeof WarmupStartResult>;
