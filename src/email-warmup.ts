import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import {
  StoredWarmupStatus, WarmupStartResult, WarmupStatus, WarmupWorkspaceRequest,
  type WarmupOperation,
} from "./email-warmup-contracts.js";

export interface MailiverySettings {
  apiKey: string;
  baseUrl?: string;
}
export interface EmailWarmupSettings {
  mailivery: MailiverySettings | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestId?: () => string;
  timeoutMs?: number;
}
interface RpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }

// Tags the jobs worker (LIF-988) matches to bind a Mailivery campaign.
export const WARMUP_WORKSPACE_TAG = "lifty-ws:";
export const WARMUP_SENDER_TAG = "lifty-sender:";
const DEFAULT_MAILIVERY_BASE = "https://app.mailivery.io/api/v1";

// Errors raised by lifty_email_warmup (LIF-987 migration 20260925123000).
const rpcMessages: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in to LIFTY before checking or changing warmup." },
  email_invalid_request: { status: 400, message: "Choose a workspace and a supported warmup action." },
  email_workspace_forbidden: { status: 403, message: "Choose a Lifty workspace you belong to." },
  email_workspace_suspended: { status: 409, message: "This workspace is paused. Resume it before starting or resuming warmup." },
  email_connection_required: { status: 409, message: "Connect and verify this workspace's email account before starting warmup." },
  email_warmup_mailbox_taken: { status: 409, message: "This mailbox is already being warmed up from another Lifty workspace. Remove warmup there first, or connect a different mailbox here." },
  email_warmup_not_started: { status: 409, message: "Warmup has not started for this mailbox. Start it first." },
};

const blockingMessages: Record<string, string> = {
  identity_mismatch: "The mailbox connected in Mailivery is not the one connected to Lifty. Remove warmup and connect the same address.",
  connection_problem: "Mailivery lost access to the mailbox. Warmup days stop counting until the mailbox is reconnected in Mailivery.",
  dns_invalid: "SPF, DMARC or MX for this domain is not valid. Warmup days don't count until all three pass.",
  status_inactive: "Mailivery reports that warmup is not running for this mailbox.",
  microsoft_consent_pending: "Microsoft still needs your consent before Mailivery can warm this mailbox. Finish the Microsoft consent step in Mailivery. You don't need a new Lifty link.",
  campaign_ambiguous: "Mailivery has more than one warmup entry for this mailbox. Setup is on hold until our team cleans it up.",
  binding_conflict: "This Mailivery warmup is already linked to a different Lifty mailbox. Our team will look into it.",
  warmup_settings_rejected: "Mailivery didn't accept the warmup settings. Our team has been alerted and will follow up.",
  warmup_start_rejected: "Mailivery didn't start warmup yet. Our team has been alerted and will follow up.",
  warmup_resume_rejected: "Mailivery didn't resume warmup yet. Our team has been alerted and will follow up.",
  workspace_suspended: "Warmup is paused because this workspace is suspended. Resume it once the workspace is active again.",
};

const stateLabels: Record<WarmupStatus["state"], string> = {
  not_started: "Not started",
  link_issued: "Waiting for you to connect the mailbox in Mailivery",
  pending_consent: "Waiting for Microsoft consent",
  warming: "Warming up",
  paused: "Paused",
  problem: "Needs attention",
  removed: "Removed",
};

// A pending remove wins over pause/resume in the database, so it wins here too.
function label(state: WarmupStatus["state"], requested: WarmupStatus["requested_action"]): string {
  if (state === "removed" || state === "not_started" || !requested) return stateLabels[state];
  if (requested === "remove") return "Removing warmup at the next check";
  if (requested === "pause") return state === "paused" ? stateLabels.paused : "Pausing warmup at the next check";
  return state === "paused" ? "Resuming warmup at the next check" : stateLabels[state];
}

function mapRpcError(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcMessages, message) ? rpcMessages[message] : undefined;
  if (!known) throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY could not read or change warmup. Retry shortly." });
  throw new PublicError({ status: known.status, code: message.toUpperCase(), message: known.message });
}

function checkValue(value: string | null | undefined): "valid" | "not_valid" | "unknown" {
  if (value === null || value === undefined || value === "") return "unknown";
  return value.toLowerCase() === "valid" ? "valid" : "not_valid";
}

function addUtcDays(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}

/** Maps the contract status object to the founder-facing shape. Pure; exported for tests. */
export function presentWarmupStatus(stored: StoredWarmupStatus, now: Date): WarmupStatus {
  const binding = stored.binding;
  const state: WarmupStatus["state"] = binding ? binding.state : "not_started";
  const snapshot = binding?.snapshot ?? null;
  const activeDays = stored.evidence?.active_duration_days ?? 0;
  const required = stored.required_active_days;
  const storedReason = binding?.blocking_reason && /^[a-z][a-z0-9_]{0,63}$/.test(binding.blocking_reason) ? binding.blocking_reason : null;
  // A campaign waiting for Microsoft consent is already bound; say what the founder must finish.
  const reasonCode = storedReason ?? (state === "pending_consent" ? "microsoft_consent_pending" : null);
  const blocking = reasonCode ? {
    code: reasonCode,
    message: blockingMessages[reasonCode] ?? "Warmup has a problem Lifty can't describe yet. Check status again later.",
  } : null;
  let goLive: WarmupStatus["recommended_go_live"];
  if (stored.mailbox_use === null) {
    goLive = { kind: "connect_email", date: null, remaining_active_days: null,
      message: "Connect an email account and say how you use it. Lifty can then tell you when campaigns can start." };
  } else if (stored.mailbox_use === "personal") {
    goLive = { kind: "now", date: addUtcDays(now, 0), remaining_active_days: null,
      message: "Campaigns can run now. Warmup is optional for a mailbox you already use." };
  } else if (stored.outreach_unlocked === true) {
    goLive = { kind: "unlocked", date: addUtcDays(now, 0), remaining_active_days: 0,
      message: "Outreach is unlocked. Keep warmup running so the mailbox stays healthy." };
  } else {
    const remaining = Math.max(0, required - activeDays);
    if (remaining === 0) {
      goLive = { kind: "awaiting_check", date: null, remaining_active_days: 0,
        message: `The mailbox has ${required} active warmup days. Lifty unlocks outreach after a healthy check from the last 24 hours, so no date is promised until that check passes.` };
    } else {
      const running = state === "warming" && !blocking && binding?.requested_action !== "pause" && binding?.requested_action !== "remove";
      const date = addUtcDays(now, remaining);
      goLive = { kind: "projected", date, remaining_active_days: remaining,
        message: `${running ? `Earliest go-live is ${date}` : `Warmup is not running right now. If it runs every day starting today, the earliest go-live is ${date}`}, after ${remaining} more active ${remaining === 1 ? "day" : "days"}. Paused days and days with a problem don't count, so the date moves later if warmup stops.` };
    }
  }
  return WarmupStatus.parse({
    provider: "mailivery",
    workspace_ref: stored.workspace_ref,
    email: stored.email,
    mailbox_use: stored.mailbox_use,
    warmup_required: stored.mailbox_use === "outreach",
    required_active_days: required,
    state,
    state_label: label(state, binding?.requested_action ?? null),
    requested_action: binding?.requested_action ?? null,
    blocking_reason: blocking,
    active_days: activeDays,
    today: { warmup_emails: snapshot?.emails_sent_today ?? null, ramp_target: snapshot?.email_per_day_target ?? null },
    checks: { spf: checkValue(snapshot?.spf), dmarc: checkValue(snapshot?.dmarc), mx: checkValue(snapshot?.mx) },
    last_checked_at: binding?.last_readback_at ?? stored.evidence?.observed_at ?? null,
    outreach_unlocked: stored.mailbox_use === "outreach" ? stored.outreach_unlocked ?? false : null,
    recommended_go_live: goLive,
  });
}

const MailiveryEnvelope = z.object({ success: z.boolean().optional(), data: z.object({ url: z.string().min(1).max(4096) }) });

/** Checks the signed hosted-form URL and reads expiry from its own `expires` claim. */
export function readSignedFormUrl(raw: string, now: Date): { url: string; expiresAt: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !(host === "mailivery.io" || host.endsWith(".mailivery.io"))) return null;
  const expires = url.searchParams.getAll("expires");
  if (expires.length !== 1 || !/^[0-9]{9,12}$/.test(expires[0]!)) return null;
  const expiresMs = Number(expires[0]) * 1000;
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= now.getTime()) return null;
  return { url: url.toString(), expiresAt: new Date(expiresMs).toISOString() };
}

export function createEmailWarmupOperations(settings: EmailWarmupSettings) {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const now = settings.now ?? (() => new Date());
  const requestId = settings.requestId ?? (() => randomUUID());
  const mailivery = settings.mailivery && settings.mailivery.apiKey.trim() ? settings.mailivery : null;
  const baseUrl = (mailivery?.baseUrl ?? DEFAULT_MAILIVERY_BASE).replace(/\/$/, "");

  async function rpc(session: AuthSession, operation: "status" | WarmupOperation, workspace: string): Promise<StoredWarmupStatus> {
    const client = session.client as RpcClient;
    let response: { data: unknown; error: unknown };
    try { response = await client.rpc("lifty_email_warmup", { p_operation: operation, p_payload: { workspace } }); }
    catch { mapRpcError(null); }
    if (response.error) mapRpcError(response.error);
    const parsed = StoredWarmupStatus.safeParse(response.data);
    if (!parsed.success) throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY returned an invalid warmup status. Retry shortly." });
    return parsed.data;
  }

  // Never logs or echoes the key, the URL signature or provider bodies.
  async function mintFormUrl(workspaceRef: string, senderRef: string): Promise<{ url: string; expiresAt: string }> {
    if (!mailivery) throw notConfigured();
    const tags = [`${WARMUP_WORKSPACE_TAG}${workspaceRef}`, `${WARMUP_SENDER_TAG}${senderRef}`];
    let body: unknown;
    try {
      const response = await fetchImpl(`${baseUrl}/embed/form/secure?tags=${encodeURIComponent(tags.join(","))}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(settings.timeoutMs ?? 15_000),
        headers: { authorization: `Bearer ${mailivery.apiKey}`, accept: "application/json", "x-request-id": requestId() },
      });
      if (!response.ok) throw new Error("provider status");
      body = await response.json();
    } catch { throw linkUnavailable(); }
    const envelope = MailiveryEnvelope.safeParse(body);
    if (!envelope.success || envelope.data.success === false) throw linkUnavailable();
    const signed = readSignedFormUrl(envelope.data.data.url, now());
    if (!signed) throw linkUnavailable();
    return signed;
  }

  async function status(session: AuthSession, workspace: string): Promise<WarmupStatus> {
    const input = WarmupWorkspaceRequest.parse({ workspace });
    return presentWarmupStatus(await rpc(session, "status", input.workspace), now());
  }

  async function start(session: AuthSession, workspace: string): Promise<WarmupStartResult> {
    const input = WarmupWorkspaceRequest.parse({ workspace });
    if (!mailivery) {
      // Without the provider key nothing is written; an existing bound warmup is still reported.
      const current = await rpc(session, "status", input.workspace);
      const state = current.binding?.state;
      if (!state || state === "removed" || state === "link_issued") throw notConfigured();
      return WarmupStartResult.parse({ ...presentWarmupStatus(current, now()), connect_url: null, expires_at: null });
    }
    const stored = await rpc(session, "start", input.workspace);
    if (!stored.binding || stored.email === null) throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY could not prepare warmup. Retry shortly." });
    // Only an unbound binding gets a form. pending_consent already has a bound
    // campaign; a second form would create another billed Mailivery campaign.
    const needsLink = stored.binding.state === "link_issued";
    const link = needsLink ? await mintFormUrl(stored.workspace_ref, stored.binding.sender_ref) : null;
    return WarmupStartResult.parse({ ...presentWarmupStatus(stored, now()),
      connect_url: link?.url ?? null, expires_at: link?.expiresAt ?? null });
  }

  const change = (operation: "pause" | "resume" | "remove") => async (session: AuthSession, workspace: string): Promise<WarmupStatus> => {
    const input = WarmupWorkspaceRequest.parse({ workspace });
    return presentWarmupStatus(await rpc(session, operation, input.workspace), now());
  };
  return { status, start, pause: change("pause"), resume: change("resume"), remove: change("remove") };
}

function notConfigured() {
  return new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." });
}
function linkUnavailable() {
  return new PublicError({ status: 502, code: "EMAIL_WARMUP_LINK_UNAVAILABLE", message: "LIFTY could not get a Mailivery connection link. Run warmup start again shortly." });
}
export type EmailWarmupOperations = ReturnType<typeof createEmailWarmupOperations>;
