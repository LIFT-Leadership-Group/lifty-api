import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import {
  StoredWarmupStatus, WarmupStartResult, WarmupStatus, WarmupWorkspaceRequest,
  type WarmupOperation, type WarmupWorkspaceInput,
} from "./email-warmup-contracts.js";
import { checkWarmupDns, WARMUP_DNS_RECORDS, type WarmupDnsRecord, type WarmupDnsResolver } from "./warmup-dns.js";

/** Server-side provider settings for the warmup setup handoff. Never public. */
export interface MailiverySettings {
  apiKey: string;
  baseUrl?: string;
}
export interface EmailWarmupSettings {
  /** The branded Google setup link. Without it, warmup setup is not available. */
  issueSetupLink?: (session: AuthSession, workspace: string, connectionRef?: string) => Promise<{url:string;expiresAt:string}>;
  now?: () => Date;
  /** DNS seam for the check before a setup link is issued; defaults to node:dns. */
  dns?: WarmupDnsResolver;
}
interface RpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }

// Errors raised by lifty_email_warmup (LIF-987 migration 20260925123000).
const rpcMessages: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in to LIFTY before checking or changing warmup." },
  email_invalid_request: { status: 400, message: "Choose a workspace and a supported warmup action." },
  email_workspace_forbidden: { status: 403, message: "Choose a workspace you belong to." },
  email_workspace_suspended: { status: 409, message: "This workspace is paused. Resume it before starting or resuming warmup." },
  email_connection_required: { status: 409, message: "Connect and verify this workspace's email account before starting warmup." },
  email_mailbox_selection_required: { status: 409, message: "This workspace has several email accounts. Choose one with connection_ref (the sending account id)." },
  email_warmup_mailbox_taken: { status: 409, message: "This mailbox is already being warmed up from another Lifty workspace. Remove warmup there first, or connect a different mailbox here." },
  email_warmup_not_started: { status: 409, message: "Warmup has not started for this mailbox. Start it first." },
  email_warmup_setup_pending: { status: 409, message: "Warmup setup is still being reconciled. No second connection will be created. Check warmup status or contact support." },
  email_warmup_setup_unavailable: { status: 409, message: "This warmup setup is already submitted or needs review. Check warmup status before trying again." },
};

export const blockingMessages: Record<string, string> = {
  identity_mismatch: "The mailbox authorized for warmup is not the one connected to Lifty. Remove warmup and authorize the same address.",
  connection_problem: "Warmup lost access to the mailbox, so active days stop counting. Our team has been alerted and will help you authorize it again.",
  dns_invalid: "SPF, DMARC or MX for this domain is not valid. Warmup days don't count until all three pass.",
  status_inactive: "Warmup is not running for this mailbox.",
  microsoft_consent_pending: "Microsoft still needs your consent before warmup can start. Finish the Microsoft consent step. You don't need a new Lifty link.",
  campaign_ambiguous: "More than one warmup entry exists for this mailbox. Setup is on hold until our team cleans it up.",
  binding_conflict: "This warmup is already linked to a different Lifty mailbox. Our team will look into it.",
  warmup_settings_rejected: "Warmup settings were not accepted. Our team has been alerted and will follow up.",
  warmup_start_rejected: "Warmup didn't start yet. Our team has been alerted and will follow up.",
  warmup_resume_rejected: "Warmup didn't resume yet. Our team has been alerted and will follow up.",
  workspace_suspended: "Warmup is paused because this workspace is suspended. Resume it once the workspace is active again.",
  account_disconnected: "Warmup is paused because this email account is disconnected. It resumes when you reconnect the same account.",
  warmup_setup_pending: "Warmup setup may still be completing. Removal stays pending until Lifty can verify and clean it up; it will not create another warmup. Contact support if this persists.",
};

// Jobs holds new warmup before start while the mailbox domain
// lacks valid SPF, DMARC or MX, naming the failing records in the reason:
// dns_invalid_dmarc, dns_invalid_spf_dmarc_mx (lift-gtm-jobs warmup-reconcile).
const DNS_HOLD = /^dns_invalid((?:_(?:spf|dmarc|mx))+)$/;
const DNS_LABELS: Record<WarmupDnsRecord, string> = { spf: "SPF", dmarc: "DMARC", mx: "MX" };
const dnsLabels = (records: readonly WarmupDnsRecord[]) => WARMUP_DNS_RECORDS.filter(id => records.includes(id)).map(id => DNS_LABELS[id]);

/** The record labels a pre-start DNS hold names, or null for any other reason. */
export function dnsHoldRecords(code: string | null | undefined): string[] | null {
  const match = code ? DNS_HOLD.exec(code) : null;
  return match ? dnsLabels(match[1]!.slice(1).split("_") as WarmupDnsRecord[]) : null;
}

/** "<domain> has no valid DMARC record. Add it with your DNS provider." plus the DMARC starter record. */
function dnsProblem(labels: readonly string[], domain = "the mailbox domain"): string {
  const list = labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${domain} has no valid ${list} ${labels.length < 2 ? "record" : "records"}. Add ${labels.length < 2 ? "it" : "them"} with your DNS provider.`
    + (labels.includes("DMARC") ? " For a new domain, a TXT record named _dmarc with v=DMARC1; p=none; is enough." : "");
}

/** Founder text for a stored blocking reason; undefined when Lifty has none. */
export function blockingMessage(code: string): string | undefined {
  const records = dnsHoldRecords(code);
  if (!records) return Object.hasOwn(blockingMessages, code) ? blockingMessages[code] : undefined;
  return `Warmup hasn't started: ${dnsProblem(records)} Lifty checks again every few minutes and starts warmup on its own once all three pass.`;
}

const stateLabels: Record<WarmupStatus["state"], string> = {
  not_started: "Not started",
  link_issued: "Waiting for you to authorize the mailbox with Google",
  pending_consent: "Waiting for Microsoft consent",
  warming: "Warming up",
  paused: "Paused",
  problem: "Needs attention",
  removed: "Removed",
};

// A pending remove wins over pause/resume in the database, so it wins here too.
function label(state: WarmupStatus["state"], requested: WarmupStatus["requested_action"], reason: string | null): string {
  const current = state === "pending_consent" && dnsHoldRecords(reason) ? "Waiting for valid DNS records" : stateLabels[state];
  if (state === "removed" || state === "not_started" || !requested) return current;
  if (requested === "remove") return "Removing warmup at the next check";
  if (requested === "pause") return state === "paused" ? stateLabels.paused : "Pausing warmup at the next check";
  return state === "paused" ? "Resuming warmup at the next check" : current;
}

function mapRpcError(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcMessages, message) ? rpcMessages[message] : undefined;
  if (!known) throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY could not read or change warmup. Retry shortly." });
  throw new PublicError({ status: known.status, code: message.toUpperCase(), message: known.message });
}

export function checkValue(value: string | null | undefined): "valid" | "not_valid" | "unknown" {
  if (value === null || value === undefined || value === "") return "unknown";
  return value.toLowerCase() === "valid" ? "valid" : "not_valid";
}

export function addUtcDays(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return date.toISOString().slice(0, 10);
}

/** Maps the contract status object to the public shape. Pure; exported for tests.
 * The go-live message describes warmup's own contribution (LIF-1228): a
 * habitual mailbox is never held by warmup; a dedicated one needs its verified
 * initial period; afterwards only warmup spam holds it. */
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
    message: blockingMessage(reasonCode) ?? "Warmup has a problem Lifty can't describe yet. Check status again later.",
  } : null;
  const spam = stored.warmup_spam;
  let goLive: WarmupStatus["recommended_go_live"];
  if (stored.connection_ref === null) {
    goLive = { kind: "connect_email", date: null, remaining_active_days: null,
      message: "Connect an email account and say how you use it. Lifty can then tell you what it needs before campaigns send." };
  } else if (stored.warmup_blocker === "email_warmup_spam" && spam) {
    goLive = { kind: "held", date: null, remaining_active_days: null,
      message: `${spam.spam_count} of ${spam.sent} warmup emails landed in spam over the last ${spam.window_days} days. Lifty holds this mailbox's sending until a later check is below the limit. Warmup keeps running.` };
  } else if (!stored.warmup_required) {
    goLive = { kind: "now", date: addUtcDays(now, 0), remaining_active_days: null,
      message: "Warmup does not hold this mailbox. It is optional for a mailbox you already use." };
  } else if (stored.warmup_complete) {
    goLive = { kind: "unlocked", date: addUtcDays(now, 0), remaining_active_days: 0,
      message: "The initial warmup period is complete. Keep warmup running while campaigns send; Lifty holds the mailbox only if warmup emails start landing in spam." };
  } else {
    const remaining = Math.max(0, required - activeDays);
    if (remaining === 0) {
      goLive = { kind: "awaiting_check", date: null, remaining_active_days: 0,
        message: `The mailbox has ${required} active warmup days. The initial period completes with Lifty's next healthy check, so no date is promised until then.` };
    } else {
      const running = state === "warming" && !blocking && binding?.requested_action !== "pause" && binding?.requested_action !== "remove";
      const date = addUtcDays(now, remaining);
      goLive = { kind: "projected", date, remaining_active_days: remaining,
        message: `${running ? `The initial period completes on ${date} at the earliest` : `Warmup is not running right now. If it runs every day starting today, the initial period completes on ${date} at the earliest`}, after ${remaining} more active ${remaining === 1 ? "day" : "days"}. Paused days and days with a problem don't count, so the date moves later if warmup stops.` };
    }
  }
  return WarmupStatus.parse({
    workspace_ref: stored.workspace_ref,
    connection_ref: stored.connection_ref,
    email: stored.email,
    mailbox_use: stored.mailbox_use,
    warmup_required: stored.warmup_required,
    required_active_days: required,
    state,
    state_label: label(state, binding?.requested_action ?? null, storedReason),
    requested_action: binding?.requested_action ?? null,
    blocking_reason: blocking,
    active_days: activeDays,
    today: { warmup_emails: snapshot?.emails_sent_today ?? null, ramp_target: snapshot?.email_per_day_target ?? null },
    checks: { spf: checkValue(snapshot?.spf), dmarc: checkValue(snapshot?.dmarc), mx: checkValue(snapshot?.mx) },
    last_checked_at: binding?.last_readback_at ?? stored.evidence?.observed_at ?? null,
    initial_period_complete: stored.warmup_complete,
    spam: spam ? { spam_count: spam.spam_count, sent: spam.sent, window_days: spam.window_days,
      holds_sending: spam.blocking, warning: spam.warning, observed_at: spam.observed_at } : null,
    outreach_unlocked: stored.warmup_ready,
    recommended_go_live: goLive,
  });
}

export function createEmailWarmupOperations(settings: EmailWarmupSettings) {
  const now = settings.now ?? (() => new Date());

  async function rpc(session: AuthSession, operation: "status" | WarmupOperation, input: WarmupWorkspaceInput): Promise<StoredWarmupStatus> {
    const client = session.client as RpcClient;
    let response: { data: unknown; error: unknown };
    try { response = await client.rpc("lifty_email_warmup", { p_operation: operation, p_payload: input }); }
    catch { mapRpcError(null); }
    if (response.error) mapRpcError(response.error);
    const parsed = StoredWarmupStatus.safeParse(response.data);
    if (!parsed.success || (input.connection_ref !== undefined && parsed.data.connection_ref !== input.connection_ref)) {
      throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY returned an invalid warmup status. Retry shortly." });
    }
    return parsed.data;
  }

  async function requireWarmupDns(email: string): Promise<void> {
    const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
    if (!domain) return;
    const { invalid } = await checkWarmupDns(domain, settings.dns ? { resolver: settings.dns } : {});
    if (invalid.length) throw new PublicError({ status: 409, code: "EMAIL_WARMUP_DNS_INVALID",
      message: `Lifty didn't create a warmup link: ${dnsProblem(dnsLabels(invalid), domain)} Run warmup start again once DNS is published. Nothing was changed.` });
  }

  const request = (workspace: string, connectionRef?: string) =>
    WarmupWorkspaceRequest.parse({ workspace, ...(connectionRef === undefined ? {} : { connection_ref: connectionRef }) });

  async function status(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStatus> {
    return presentWarmupStatus(await rpc(session, "status", request(workspace, connectionRef)), now());
  }

  async function start(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStartResult> {
    const input = request(workspace, connectionRef);
    // Read-only: decides whether start would issue a link before anything is written.
    const current = await rpc(session, "status", input);
    const state = current.binding?.state;
    const linkNext = !state || state === "removed" || state === "link_issued";
    if (!settings.issueSetupLink) {
      // Google setup is the only setup method; nothing is written without it.
      if (linkNext) throw notConfigured();
      return WarmupStartResult.parse({ ...presentWarmupStatus(current, now()), connect_url: null, expires_at: null });
    }
    // Warmup does not start on a domain without valid SPF, DMARC and MX, so
    // the founder publishes them before consent. Only a verified missing or
    // invalid record refuses; an unanswered lookup issues the link and the
    // Jobs pre-start hold still guards the warmup.
    if (linkNext && current.email) await requireWarmupDns(current.email);
    const stored = await rpc(session, "start", input);
    if (!stored.binding || stored.email === null) throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "LIFTY could not prepare warmup. Retry shortly." });
    // Only an unbound binding gets a link; a bound one needs no second setup.
    const link = stored.binding.state === "link_issued"
      ? await settings.issueSetupLink(session, input.workspace, stored.connection_ref ?? input.connection_ref) : null;
    return WarmupStartResult.parse({ ...presentWarmupStatus(stored, now()),
      connect_url: link?.url ?? null, expires_at: link?.expiresAt ?? null });
  }

  const change = (operation: "pause" | "resume" | "remove") => async (session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStatus> =>
    presentWarmupStatus(await rpc(session, operation, request(workspace, connectionRef)), now());
  return { status, start, pause: change("pause"), resume: change("resume"), remove: change("remove") };
}

function notConfigured() {
  return new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." });
}
export type EmailWarmupOperations = ReturnType<typeof createEmailWarmupOperations>;
