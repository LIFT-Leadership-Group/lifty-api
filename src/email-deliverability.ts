import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { REQUIRED_WARMUP_ACTIVE_DAYS } from "./email-warmup-contracts.js";
import { addUtcDays, blockingMessages, checkValue } from "./email-warmup.js";
import {
  DELIVERABILITY_DETAIL_MAX_REPORTS, DELIVERABILITY_SCHEMA_VERSION, DeliverabilityQuery, DeliverabilityResponse, DeliverabilitySource,
  type Campaign, type DeliverabilityMailbox, type DeliverabilityQueryInput, type PlacementDetail, type PlacementTest, type Reason,
  type SourceCampaign, type SourceConnection, type SourceMailbox, type SourceMailivery, type SourceTest, type State, type WarmupSource,
} from "./email-deliverability-contracts.js";
import type { PlacementReportReader } from "./email-deliverability-placement.js";

// Canonical rules this presentation explains; none of them is decided here.
/** sender_mailbox_eligibility: a Smartlead warmup check counts for 26 hours. */
const SMARTLEAD_WARMUP_FRESH_HOURS = 26;
/** sender_mailbox_eligibility: live warmup needs 20 sends in 7 days and one in 48 hours. */
const SMARTLEAD_WARMUP_MIN_SENDS_7D = 20;
const SMARTLEAD_WARMUP_MAX_SEND_GAP_HOURS = 48;
/** lifty_email_warmup_unlocked / outreach_email_warmup_status: 24-hour evidence. */
const MAILIVERY_EVIDENCE_FRESH_HOURS = 24;
/**
 * Placement evidence is current for 10 days: jobs DELIVERABILITY_POLICY_V1
 * placementStaleDays for Smartlead inboxes, and outreach_email_mailbox_ready /
 * lifty_email_sender_gate for Unipile connections under the strict policy.
 */
const PLACEMENT_FRESH_DAYS = 10;
/** jobs DELIVERABILITY_POLICY_V1.mitigationRewarmDays. */
const MITIGATION_REWARM_DAYS = 14;
const TREND_DAYS = 30;
const LIFTY_BETA_POLICY = /^lifty\.personal-beta\./;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Tone = State["tone"];
const reason = (code: string, message: string): Reason => ({ code, message: message.slice(0, 400) });
function make<C extends string>(code: C, label: string, tone: Tone, description: string, reasons: Reason[] = []): State<C> {
  return { code, label: label.slice(0, 120), tone, description: description.slice(0, 600), reasons: dedupe(reasons).slice(0, 20) };
}
function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter(item => !seen.has(`${item.code}:${item.message}`) && seen.add(`${item.code}:${item.message}`));
}
const ms = (value: string | null | undefined) => value ? Date.parse(value) : Number.NaN;
const iso = (at: number) => new Date(at).toISOString();
const day = (value: string | null | undefined) => value ? value.slice(0, 10) : null;
const n = <T>(value: T | null | undefined): T | null => value ?? null;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** Stored reason codes such as placement_failed read as words. */
const words = (value: string) => value.replace(/_/g, " ");

type Evidence = { observed_at: string | null; freshness: "fresh" | "stale" | "unknown" | "not_applicable"; fresh_until: string | null };
/** Missing evidence and an unknown rule are both "unknown"; never fresh by default. */
function freshness(observedAt: string | null | undefined, maxAgeMs: number | null, now: Date): Evidence {
  const observed = ms(observedAt);
  if (!Number.isFinite(observed)) return { observed_at: null, freshness: "unknown", fresh_until: null };
  if (maxAgeMs === null) return { observed_at: iso(observed), freshness: "unknown", fresh_until: null };
  return { observed_at: iso(observed), freshness: now.getTime() <= observed + maxAgeMs ? "fresh" : "stale", fresh_until: iso(observed + maxAgeMs) };
}

// ------------------------------------------------------------- placement

function executionOf(test: SourceTest): Pick<PlacementTest, "execution_status" | "execution_reason"> {
  const failure = test.failure_code ?? null;
  const policy = failure && LIFTY_BETA_POLICY.test(failure)
    ? reason("disabled_by_policy", "Placement tests are disabled by this workspace's beta policy. This request will not run.") : null;
  switch (test.execution_status) {
    case "completed": return { execution_status: "completed", execution_reason: null };
    case "running": return { execution_status: "running", execution_reason: policy };
    case "queued": case "ready":
      return { execution_status: "pending", execution_reason: policy };
    case "awaiting_confirmation":
      return { execution_status: "pending", execution_reason: policy ?? reason("awaiting_confirmation", "Waiting for someone to review the seed recipients and authorize the test. No seed email is sent before that.") };
    case "failed":
      return { execution_status: "error", execution_reason: policy ?? reason(failure && /^[a-z][a-z0-9_]{0,63}$/.test(failure) ? failure : "execution_failed",
        failure ? `The test did not complete (${failure}). This is not a placement result.` : "The test did not complete. This is not a placement result.") };
    case "blocked":
      return { execution_status: "error", execution_reason: policy ?? reason("blocked", "Safety checks stopped this test before it sent. This is not a placement result.") };
    case "ambiguous":
      return { execution_status: "unknown", execution_reason: reason("ambiguous", "The provider's result is uncertain. Check the existing test before creating another.") };
    default:
      return { execution_status: "unknown", execution_reason: reason("unknown_execution_state", "The test's execution state is not recognized.") };
  }
}

function counts(source: SourceTest["counts"]): PlacementTest["counts"] {
  if (!source) return null;
  return { inbox: n(source.inbox), spam: n(source.spam), other: n(source.other), missing: n(source.missing), total: n(source.total) };
}

function presentTest(test: SourceTest, now: Date): PlacementTest {
  const execution = executionOf(test);
  const verdict = execution.execution_status === "completed" && typeof test.passed === "boolean" ? (test.passed ? "pass" : "fail") : "unknown";
  const tally = test.counts?.inbox != null && test.counts?.total != null ? ` · ${test.counts.inbox}/${test.counts.total} inbox` : "";
  const label = execution.execution_status === "completed"
    ? verdict === "pass" ? `Passed${tally}` : verdict === "fail" ? `Failed${tally}` : "Completed · no verdict"
    : execution.execution_status === "pending" ? (execution.execution_reason?.code === "awaiting_confirmation" ? "Waiting for authorization"
      : execution.execution_reason?.code === "disabled_by_policy" ? "Not run · disabled by policy" : "Pending")
    : execution.execution_status === "running" ? "Running" : execution.execution_status === "error" ? "Did not run" : "Uncertain";
  const families = test.families ? {
    gmail: test.families.gmail ? counts(test.families.gmail) : null,
    outlook: test.families.o365 ? counts(test.families.o365) : null,
  } : null;
  const smartleadReport = test.provider === "smartlead" && /^[0-9]{1,15}$/.test(test.provider_test_ref ?? "");
  return {
    test_ref: test.test_ref,
    provider: /^[a-z][a-z0-9_-]{0,39}$/.test(test.provider) ? test.provider : "other",
    source: test.source, name: n(test.name), ...execution, verdict, label,
    tested_at: iso(ms(test.tested_at)), completed_at: test.completed_at ? iso(ms(test.completed_at)) : null,
    age_days: Math.max(0, Math.floor((now.getTime() - ms(test.completed_at ?? test.tested_at)) / DAY)),
    policy_version: n(test.policy_version), counts: counts(test.counts), families,
    detail_available: execution.execution_status === "completed" && (smartleadReport || Boolean(families?.gmail || families?.outlook)),
  };
}

function placementRule(mailbox: SourceMailbox): { maxAgeDays: number | null; rule: string; applies: boolean; disabled: boolean } {
  if (mailbox.smartlead) return { maxAgeDays: PLACEMENT_FRESH_DAYS, applies: true, disabled: false,
    rule: `LIFT's deliverability policy treats a placement result as current for ${PLACEMENT_FRESH_DAYS} days.` };
  if (mailbox.warmup.mailivery.some(item => item.binding)) return { maxAgeDays: PLACEMENT_FRESH_DAYS, applies: true, disabled: false,
    rule: `This inbox's send check needs a passing placement test from the last ${PLACEMENT_FRESH_DAYS} days.` };
  const beta = [...mailbox.placement.recent_tests, mailbox.placement.latest_completed_test]
    .some(test => test?.failure_code && LIFTY_BETA_POLICY.test(test.failure_code));
  if (beta) return { maxAgeDays: null, applies: false, disabled: true, rule: "Placement tests are disabled by this workspace's beta policy." };
  return { maxAgeDays: null, applies: false, disabled: false, rule: "No placement freshness rule is known for this inbox, so its age is shown without a verdict on currency." };
}

function presentPlacement(mailbox: SourceMailbox, now: Date, detail: PlacementDetail[] | null): DeliverabilityMailbox["placement"] {
  const source = mailbox.placement;
  const recent = source.recent_tests.map(test => presentTest(test, now));
  const latestCompleted = source.latest_completed_test ? presentTest(source.latest_completed_test, now) : null;
  const rule = placementRule(mailbox);
  const measured = freshness(source.latest_completed_test?.completed_at ?? source.latest_completed_test?.tested_at,
    rule.maxAgeDays === null ? null : rule.maxAgeDays * DAY, now);
  const evidence = { ...measured, freshness: rule.disabled ? "not_applicable" as const : measured.freshness, max_age_days: rule.maxAgeDays, rule: rule.rule };
  const reasons: Reason[] = [];
  const latestAttempt = recent.find(test => test.test_ref === source.latest_test_ref) ?? null;
  if (source.latest_test_ref && source.latest_test_ref !== source.latest_completed_test_ref) {
    const attempt = latestAttempt;
    if (!attempt) reasons.push(reason("newer_attempt", "A newer test attempt exists without a result."));
    else if (attempt.execution_status === "pending" || attempt.execution_status === "running")
      reasons.push(reason("newer_test_in_progress", `A newer test from ${day(attempt.tested_at)} is ${attempt.execution_status === "running" ? "running" : "pending"}; the result below is the latest completed one.`));
    else if (attempt.execution_status === "error")
      reasons.push(reason("newer_test_did_not_run", `The newest test from ${day(attempt.tested_at)} did not run${attempt.execution_reason ? `: ${attempt.execution_reason.message}` : "."}`));
    else if (attempt.execution_status === "unknown") reasons.push(reason("newer_test_uncertain", `The newest test from ${day(attempt.tested_at)} has an uncertain result.`));
    else if (attempt.verdict === "unknown") reasons.push(reason("newer_test_no_verdict", `The newest test from ${day(attempt.tested_at)} completed without a verdict.`));
  }
  if (latestAttempt?.execution_reason?.code === "disabled_by_policy") reasons.push(latestAttempt.execution_reason);
  let status: DeliverabilityMailbox["placement"]["status"];
  if (source.test_count === 0) {
    status = make("no_tests", "No placement test yet", rule.applies ? "warn" : "muted",
      rule.applies ? "No placement test has been recorded for this inbox. Missing evidence is not a passing result." : `No placement test has been recorded for this inbox. ${rule.rule}`, reasons);
  } else if (!latestCompleted) {
    status = make("no_result", "No placement result yet", "warn",
      "Tests were attempted, but none has completed with a result. A pending or failed run is not a placement verdict.", reasons);
  } else if (latestCompleted.verdict === "fail") {
    status = make("failed", `Failed placement · ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)}`, "bad",
      `The latest completed test failed: ${latestCompleted.label}.${evidence.freshness === "stale" ? ` It is older than ${rule.maxAgeDays} days.` : ""}`, reasons);
  } else if (latestCompleted.verdict === "unknown") {
    status = make("no_result", "Latest test has no verdict", "warn", "The latest completed test was stored without a pass or fail verdict. It is not treated as passed.", reasons);
  } else if (evidence.freshness === "stale") {
    status = make("stale", `Passed ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)} · out of date`, "warn",
      `The latest completed test passed, but it is older than ${rule.maxAgeDays} days, so it no longer counts as current evidence.`, reasons);
  } else {
    status = make("passed", `Passed · ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)}`, "ok",
      `The latest completed test passed: ${latestCompleted.label}. ${rule.rule}`, reasons);
  }
  return {
    status, evidence, test_count: source.test_count,
    latest_test_ref: n(source.latest_test_ref), latest_completed_test_ref: n(source.latest_completed_test_ref),
    latest_completed_test: latestCompleted, recent_tests: recent, detail,
  };
}

// ---------------------------------------------------------------- warmup

function smartleadWarmup(mailbox: SourceMailbox, now: Date): WarmupSource | null {
  const w = mailbox.warmup.smartlead;
  if (!w) return null;
  const registry = mailbox.smartlead;
  const check = freshness(w.observed_at, SMARTLEAD_WARMUP_FRESH_HOURS * HOUR, now);
  const reasons: Reason[] = [];
  if (check.freshness === "stale") reasons.push(reason("warmup_check_stale", `The latest Smartlead warmup check is older than ${SMARTLEAD_WARMUP_FRESH_HOURS} hours.`));
  const detail = w.detail ? ` ${w.detail}` : "";
  let state: WarmupSource["state"];
  if (w.status === "active" && w.health === "pass") state = make("active", "Warming", "ok", "Smartlead warmup is running and its latest check passed.", reasons);
  else if (w.status === "active" && w.health === "pending") state = make("active", "Warming · low activity", "watch",
    "Smartlead warmup is running, but recent warmup activity is below the minimum for a passing check.", [...reasons, reason("warmup_activity_low", `Warmup activity is below the minimum.${detail}`)]);
  else if (w.status === "active" && w.health === "fail") state = make("problem", "Warmup failing", "bad",
    "Smartlead warmup is running, but its latest check failed.", [...reasons, reason("warmup_health_failed", `The latest warmup check failed.${detail}`)]);
  else if (w.status === "inactive") state = make("not_running", "Warmup off", "warn", "Smartlead reports that warmup is not running for this inbox.", reasons);
  else if (w.status === "blocked") state = make("problem", "Warmup blocked", "bad", "Smartlead reports that warmup is blocked for this inbox.", [...reasons, reason("warmup_blocked", `Smartlead blocked warmup.${detail}`)]);
  else state = make("unknown", "Warmup state unknown", "warn", "The latest Smartlead check could not determine the warmup state.", reasons);
  const activeDays = w.active_since ? Math.max(0, Math.floor((ms(w.observed_at) - ms(w.active_since)) / DAY)) : null;
  const eligibleAt = ms(registry?.cold_eligible_at);
  const complete = Number.isFinite(eligibleAt) ? eligibleAt <= now.getTime() : activeDays === null ? null : activeDays >= REQUIRED_WARMUP_ACTIVE_DAYS;
  return {
    provider: "smartlead", connection_ref: null, state,
    started_at: w.active_since ? iso(ms(w.active_since)) : null, started_at_basis: w.active_since ? "observed_activity" : null,
    active_days: activeDays, required_days: REQUIRED_WARMUP_ACTIVE_DAYS, period_complete: complete,
    estimated_completion: complete === false && Number.isFinite(eligibleAt) ? { at: iso(eligibleAt), on: null,
      basis: registry?.approved_for_outbound
        ? `Estimated: the registry warmup start plus ${REQUIRED_WARMUP_ACTIVE_DAYS} days.`
        : `Estimated: continuous warmup activity since ${day(w.active_since)} plus ${REQUIRED_WARMUP_ACTIVE_DAYS} days. A gap in activity restarts the count.` } : null,
    outreach_unlocked: null, last_check: check,
    metrics: { reputation_pct: n(w.reputation_pct), spam_pct: n(w.spam_pct), spam_sample_sent: n(w.spam_sample_sent), spam_count: n(w.spam_count),
      sent_7d: n(w.sent_7d), last_sent_at: w.last_sent_at ? iso(ms(w.last_sent_at)) : null, warmup_emails_today: null, ramp_target: null },
    checks: null, provider_detail: n(w.detail),
  };
}

function mailiveryWarmup(item: SourceMailivery, connection: SourceConnection | undefined, now: Date): WarmupSource {
  const binding = item.binding ?? null;
  const evidence = item.evidence ?? null;
  const reasons: Reason[] = [];
  const blocking = binding?.blocking_reason && /^[a-z][a-z0-9_]{0,63}$/.test(binding.blocking_reason) ? binding.blocking_reason
    : binding?.state === "pending_consent" ? "microsoft_consent_pending" : null;
  if (blocking) reasons.push(reason(blocking, blockingMessages[blocking] ?? "Warmup has a problem Lifty can't describe yet."));
  if (binding?.requested_action === "pause") reasons.push(reason("pause_requested", "Pausing warmup at the next check."));
  if (binding?.requested_action === "resume") reasons.push(reason("resume_requested", "Resuming warmup at the next check."));
  if (binding?.requested_action === "remove") reasons.push(reason("remove_requested", "Removing warmup at the next check."));
  if (evidence?.healthy === false) reasons.push(reason("warmup_unhealthy", "The latest warmup check was not healthy. Days with a problem don't count."));
  const check = freshness(evidence?.observed_at, MAILIVERY_EVIDENCE_FRESH_HOURS * HOUR, now);
  if (check.freshness === "stale") reasons.push(reason("warmup_check_stale", `The latest warmup check is older than ${MAILIVERY_EVIDENCE_FRESH_HOURS} hours.`));
  let state: WarmupSource["state"];
  switch (binding?.state) {
    case "warming": state = make("active", "Warming", blocking || evidence?.healthy === false ? "warn" : "ok", "Mailivery is warming this inbox.", reasons); break;
    case "link_issued": state = make("pending", "Waiting for mailbox connection", "watch", "Warmup starts after the mailbox is connected in Mailivery.", reasons); break;
    case "pending_consent": state = make("pending", "Waiting for Microsoft consent", "watch", "Warmup starts after Microsoft consent is finished in Mailivery.", reasons); break;
    case "paused": state = make("paused", "Paused", "warn", "Mailivery warmup is paused. Paused days don't count toward the warmup period.", reasons); break;
    case "problem": state = make("problem", "Needs attention", "bad", "Mailivery warmup has a problem. Days with a problem don't count.", reasons); break;
    case "removed": state = make("not_running", "Removed", "muted", "Mailivery warmup was removed for this inbox.", reasons); break;
    default: state = make("unknown", "Warmup state unknown", "warn", "Warmup evidence exists, but no current Mailivery setup is recorded.", reasons);
  }
  const personal = connection?.mailbox_use === "personal";
  const required = personal ? null : REQUIRED_WARMUP_ACTIVE_DAYS;
  const activeDays = evidence?.active_duration_days ?? null;
  const complete = required === null || activeDays === null ? null : activeDays >= required;
  const remaining = required !== null && activeDays !== null ? Math.max(0, required - activeDays) : null;
  const snapshot = binding?.snapshot ?? null;
  return {
    provider: "mailivery", connection_ref: item.connection_ref, state,
    started_at: evidence?.started_at ? iso(ms(evidence.started_at)) : null, started_at_basis: evidence?.started_at ? "provider_evidence" : null,
    active_days: activeDays, required_days: required, period_complete: complete,
    estimated_completion: complete === false && remaining !== null ? { at: null, on: addUtcDays(now, remaining),
      basis: "Estimated if warmup runs every day from today. Paused days and days with a problem don't count, so the date moves later if warmup stops." } : null,
    outreach_unlocked: personal ? null : n(item.outreach_unlocked),
    last_check: { ...check, observed_at: check.observed_at ?? (binding?.last_readback_at ? iso(ms(binding.last_readback_at)) : null) },
    metrics: { reputation_pct: null, spam_pct: null, spam_sample_sent: null, spam_count: null, sent_7d: null, last_sent_at: null,
      warmup_emails_today: n(snapshot?.emails_sent_today), ramp_target: n(snapshot?.email_per_day_target) },
    checks: snapshot ? { spf: checkValue(snapshot.spf), dmarc: checkValue(snapshot.dmarc), mx: checkValue(snapshot.mx) } : null,
    provider_detail: null,
  };
}

const warmupRank: Record<WarmupSource["state"]["code"], number> = { problem: 0, not_running: 1, paused: 2, unknown: 3, pending: 4, active: 5, none: 6 };

function presentWarmup(mailbox: SourceMailbox, now: Date): DeliverabilityMailbox["warmup"] {
  const smartlead = smartleadWarmup(mailbox, now);
  const sources = [...(smartlead ? [smartlead] : []),
    ...mailbox.warmup.mailivery.map(item => mailiveryWarmup(item, mailbox.connections.find(c => c.connection_ref === item.connection_ref), now))];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const trend = {
    window_start: iso(end.getTime() - (TREND_DAYS - 1) * DAY).slice(0, 10), window_end: iso(end.getTime()).slice(0, 10),
    days: mailbox.warmup.smartlead_daily.map(point => ({ day: point.day, observed_at: iso(ms(point.observed_at)), status: point.status, health: point.health,
      reputation_pct: n(point.reputation_pct), spam_pct: n(point.spam_pct), spam_sample_sent: n(point.spam_sample_sent), sent_7d: n(point.sent_7d) })),
  };
  if (sources.length === 0) {
    return { status: make("none", "No warmup evidence", "muted", "No warmup provider has reported on this inbox. Missing evidence is not a healthy result."), sources, trend };
  }
  const worst = [...sources].sort((a, b) => warmupRank[a.state.code] - warmupRank[b.state.code])[0]!;
  const progress = sources.find(source => source.required_days !== null && source.active_days !== null) ?? null;
  let label = worst.state.label;
  if (worst.state.code === "active" && progress) {
    label = progress.period_complete ? `${worst.state.label} · initial period complete` : `${worst.state.label} · day ${progress.active_days} of ${progress.required_days}`;
  }
  const names = sources.map(source => source.provider === "smartlead" ? "Smartlead" : "Mailivery").join(" and ");
  const period = progress?.period_complete ? " The initial warmup period is complete; warmup can keep running after it, and that alone does not enable campaigns." : "";
  return {
    status: make(worst.state.code, label, worst.state.tone, `${worst.state.description}${sources.length > 1 ? ` Evidence comes from ${names}.` : ""}${period}`,
      sources.flatMap(source => source.state.reasons)),
    sources, trend,
  };
}

// ------------------------------------------------------ readiness and gates

const controlReasons: Record<string, string> = {
  workspace_suspended: "This workspace is paused.",
  sender_inactive: "The sender for this connection is inactive.",
  connection_unavailable: "The connection is not connected.",
  channel_paused: "Email is paused for this workspace.",
  pilot_cohort_unconfigured: "Direct Unipile sending is held until LIFT's email pilot cohort is configured.",
  pilot_cohort_excluded: "This lead is outside the configured email pilot cohort.",
  sender_mailbox_ineligible: "This inbox hasn't passed its warmup and placement checks for sending.",
  owner_mismatch: "The lead belongs to a different sender.",
};

function controlScope(scopeKey: string): Connection["controls"][number]["scope"] {
  if (scopeKey === "global") return "global";
  const parts = scopeKey.split(":");
  if (parts.includes("connection")) return "connection";
  if (parts.includes("sender")) return "sender";
  if (parts.length === 2) return "channel";
  if (parts.length === 1 && /^[0-9a-f-]{36}$/i.test(scopeKey)) return "workspace";
  return "other";
}
type Connection = DeliverabilityMailbox["connections"][number];

function controlReason(value: string): Reason {
  if (value.startsWith("send_paused:")) {
    const scope = controlScope(value.slice("send_paused:".length));
    return reason("send_paused", scope === "global" ? "Sending is paused for all LIFT email." : `Sending is paused at the ${scope} level.`);
  }
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "send_blocked";
  return reason(code, controlReasons[value] ?? "A send control blocks this connection.");
}

function smartleadPath(mailbox: SourceMailbox, now: Date): DeliverabilityMailbox["readiness"]["paths"][number] | null {
  const m = mailbox.smartlead;
  if (!m) return null;
  const base = { provider: "smartlead", connection_ref: null, gate: "smartlead_eligibility" as const };
  if (m.is_eligible === true) return { ...base, state: make("allowed", "Allowed to send", "ok", "Passes the Smartlead eligibility rules: approved, warmed, placement-gated, live warmup and no mitigation.") };
  if (m.is_eligible == null) return { ...base, state: make("unknown", "Eligibility unknown", "warn", "The Smartlead registry did not report eligibility.") };
  const reasons: Reason[] = [];
  if (m.mitigation_state === "retired") reasons.push(reason("retired", "The inbox is retired."));
  else if (m.mitigation_state && m.mitigation_state !== "none") reasons.push(reason("mitigation_paused", `Paused by deliverability mitigation${m.mitigation_reason ? ` (${words(m.mitigation_reason)})` : ""}.`));
  if (!m.approved_for_outbound) reasons.push(reason("not_approved", "Not approved for outbound yet."));
  if (!m.placement_gate_passed_at) reasons.push(reason("placement_gate_not_passed", "Hasn't passed the placement gate."));
  const started = ms(m.warmup_started_at);
  if (Number.isFinite(started) && started + REQUIRED_WARMUP_ACTIVE_DAYS * DAY > now.getTime()) {
    reasons.push(reason("warmup_period_incomplete", `The registry's ${REQUIRED_WARMUP_ACTIVE_DAYS}-day warmup period ends ${day(iso(started + REQUIRED_WARMUP_ACTIVE_DAYS * DAY))}.`));
  }
  const w = mailbox.warmup.smartlead;
  if (!w) reasons.push(reason("warmup_check_missing", "No Smartlead warmup check is recorded."));
  else {
    if (w.status !== "active") reasons.push(reason("warmup_not_active", `Smartlead warmup is ${w.status}.`));
    if (now.getTime() - ms(w.observed_at) > SMARTLEAD_WARMUP_FRESH_HOURS * HOUR) reasons.push(reason("warmup_check_stale", `The latest warmup check is older than ${SMARTLEAD_WARMUP_FRESH_HOURS} hours.`));
    const grace = ms(m.warmup_activity_grace_until) > now.getTime();
    if (w.health === "pending" && !grace) reasons.push(reason("warmup_activity_low", `Warmup activity is below the minimum${w.detail ? `: ${w.detail}` : "."}`));
    else if (w.health === "pass" && ((w.sent_7d ?? 0) < SMARTLEAD_WARMUP_MIN_SENDS_7D
      || !(ms(w.last_sent_at) >= now.getTime() - SMARTLEAD_WARMUP_MAX_SEND_GAP_HOURS * HOUR))) {
      reasons.push(reason("warmup_activity_low", `Live warmup needs ${SMARTLEAD_WARMUP_MIN_SENDS_7D} sends in 7 days and one in the last ${SMARTLEAD_WARMUP_MAX_SEND_GAP_HOURS} hours.`));
    } else if (w.health !== "pass" && w.health !== "pending") reasons.push(reason("warmup_health_failed", `Warmup health is ${w.health}${w.detail ? `: ${w.detail}` : "."}`));
  }
  if (reasons.length === 0) reasons.push(reason("not_eligible", "Not eligible under the current Smartlead rules."));
  return { ...base, state: make("blocked", "Blocked", "bad", "Doesn't meet the Smartlead eligibility rules yet.", reasons) };
}

function connectionGate(mailbox: SourceMailbox, connection: SourceConnection): Connection["send_gate"] & { gate: DeliverabilityMailbox["readiness"]["paths"][number]["gate"] } {
  const managedBy = mailbox.workspace_managed_by ?? null;
  if (managedBy === "lift") {
    return connection.send_block_reason
      ? { gate: "lift_send_controls", ...make("blocked", "Blocked", "bad", "LIFT's send controls block this connection.", [controlReason(connection.send_block_reason)]) }
      : { gate: "lift_send_controls", ...make("allowed", "Allowed to send", "ok", "Passes LIFT's send controls, including this inbox's warmup and placement checks.") };
  }
  if (managedBy === "lifty") {
    const reasons: Reason[] = [];
    if (connection.status !== "connected") reasons.push(reason("connection_unavailable", `The connection is ${connection.status}.`));
    for (const hold of connection.holds) reasons.push(reason("hold", `A safety hold is active (${hold.reason}).`));
    if (!connection.mailbox_use) reasons.push(reason("mailbox_use_required", "Say whether this is a mailbox you already use or a new outreach account before sending. Reconnect the email account to answer."));
    const unlocked = mailbox.warmup.mailivery.find(item => item.connection_ref === connection.connection_ref)?.outreach_unlocked === true;
    if (connection.mailbox_use === "outreach" && !unlocked) reasons.push(reason("warmup_required", `A new outreach account needs ${REQUIRED_WARMUP_ACTIVE_DAYS} active warmup days and a healthy check from the last 24 hours before it can send.`));
    return reasons.length > 0
      ? { gate: "lifty_campaign_checks", ...make("blocked", "Blocked", "bad", "Lifty's send checks block this connection.", reasons) }
      : { gate: "lifty_campaign_checks", ...make("no_known_blocker", "No known blocker", "watch",
        "Nothing recorded blocks this connection. Lifty runs the remaining checks, such as a fresh connection check, when a campaign sends.") };
  }
  return connection.send_block_reason
    ? { gate: "unknown", ...make("blocked", "Blocked", "bad", "A send control blocks this connection.", [controlReason(connection.send_block_reason)]) }
    : { gate: "unknown", ...make("unknown", "Send checks unknown", "warn", "This server's data doesn't say which send checks govern this connection.") };
}

function presentConnection(mailbox: SourceMailbox, connection: SourceConnection): Connection & { gate: DeliverabilityMailbox["readiness"]["paths"][number]["gate"] } {
  const { gate, ...sendGate } = connectionGate(mailbox, connection);
  return {
    gate,
    connection_ref: connection.connection_ref,
    provider: /^[a-z][a-z0-9_-]{0,39}$/.test(connection.provider) ? connection.provider : "other",
    status: connection.status, sender_ref: n(connection.sender_ref), mailbox_use: n(connection.mailbox_use),
    daily_send_limit: n(connection.daily_send_limit), health_checked_at: connection.health_checked_at ? iso(ms(connection.health_checked_at)) : null,
    created_at: iso(ms(connection.created_at)), send_gate: sendGate,
    controls: connection.controls.map(control => ({ scope: controlScope(control.scope_key), send_paused: control.send_paused,
      capture_paused: control.capture_paused, updated_at: control.updated_at ? iso(ms(control.updated_at)) : null })),
    holds: connection.holds.map(hold => ({ reason: hold.reason, updated_at: hold.updated_at ? iso(ms(hold.updated_at)) : null })),
  };
}

function presentReadiness(paths: DeliverabilityMailbox["readiness"]["paths"]): DeliverabilityMailbox["readiness"] {
  const codes = paths.map(path => path.state.code);
  const name = (path: (typeof paths)[number]) => path.provider === "smartlead" ? "Smartlead" : `${path.provider[0]!.toUpperCase()}${path.provider.slice(1)} connection`;
  const blockedReasons = paths.filter(path => path.state.code !== "allowed")
    .flatMap(path => path.state.reasons.map(item => reason(item.code, `${name(path)}: ${item.message}`)));
  let summary: State<DeliverabilityMailbox["readiness"]["code"]>;
  if (paths.length === 0) summary = make("unknown", "No sending path", "muted", "This inbox has no Smartlead registry record and no email connection, so nothing can send from it.");
  else if (codes.every(code => code === "allowed")) summary = make("ready", "Ready to send", "ok",
    `Allowed to send through ${paths.map(name).join(" and ")}. Being allowed doesn't mean it is sending; see campaigns.`);
  else if (codes.includes("allowed")) summary = make("partially_ready", "Ready on some paths", "watch",
    `Allowed through ${paths.filter(path => path.state.code === "allowed").map(name).join(" and ")}; other paths are blocked or unknown.`, blockedReasons);
  else if (codes.includes("no_known_blocker")) summary = make("no_known_blocker", "No known blocker", "watch",
    "Nothing recorded blocks sending. The remaining checks run when a campaign sends.", blockedReasons);
  else if (codes.every(code => code === "blocked")) summary = make("blocked", "Not ready to send", "bad", "Every sending path for this inbox is blocked.", blockedReasons);
  else summary = make("unknown", "Readiness unknown", "warn", "At least one sending path couldn't be evaluated from the stored data.", blockedReasons);
  return { ...summary, paths };
}

// ------------------------------------------------------------- campaigns

const campaignLabels: Record<Campaign["status"]["code"], [string, Tone]> = {
  active: ["Active", "ok"], paused: ["Paused", "warn"], draft: ["Draft", "muted"], closed_to_new_leads: ["Closed to new leads", "muted"],
  completed: ["Completed", "muted"], archived: ["Archived", "muted"], error: ["Error", "bad"], unknown: ["Unknown", "warn"],
};

function presentCampaign(source: SourceCampaign, paths: DeliverabilityMailbox["readiness"]["paths"]): Campaign {
  let code: Campaign["status"]["code"];
  let states: Record<string, number>;
  if (source.source === "smartlead_campaign") {
    code = (["active", "paused", "draft", "closed_to_new_leads", "archived", "error"] as const).find(value => value === source.status) ?? "unknown";
    states = { [source.status]: 1 };
  } else {
    states = source.states;
    code = (states.active ?? 0) > 0 ? "active" : (states.paused ?? 0) > 0 ? "paused"
      : (states.draft ?? 0) + (states.approved ?? 0) > 0 ? "draft" : "completed";
  }
  const [label, tone] = campaignLabels[code];
  const status = make(code, label, tone, source.source === "smartlead_campaign"
    ? `The campaign record says ${label.toLowerCase()}${source.provider_status ? ` (provider: ${source.provider_status})` : ""}. This is LIFT's configuration, not a live provider readback.`
    : `${plural(source.campaign_count, "direct Lifty campaign")} use this connection: ${Object.entries(states).map(([key, count]) => `${count} ${key}`).join(", ")}.`);
  const path = source.source === "smartlead_campaign"
    ? paths.find(item => item.gate === "smartlead_eligibility")
    : paths.find(item => item.connection_ref === source.connection_ref);
  let sending: Campaign["sending"];
  if (code !== "active") sending = make("not_active", "Not active", "muted", "The campaign isn't active, so this inbox doesn't send for it.");
  else if (source.source === "smartlead_campaign" && (source.drift_detected_at || source.status === "error")) {
    sending = make("unverified", "Unverified", "warn", "The campaign record disagrees with the provider or reports an error, so its state can't be confirmed.",
      source.drift_detected_at ? [reason("drift_detected", `Provider drift detected ${day(source.drift_detected_at)}.`)] : []);
  } else if (!path || path.state.code === "unknown") sending = make("unverified", "Unverified", "warn", "Lifty can't tell whether this inbox passes the send checks for this campaign.");
  else if (path.state.code === "blocked") sending = make("blocked", "Blocked", "bad", "The campaign is active, but this inbox is blocked from sending.", path.state.reasons);
  else sending = make("enabled", path.state.code === "allowed" ? "Allowed to send" : "No known blocker", path.state.code === "allowed" ? "ok" : "watch",
    "The campaign is active and this inbox passes its send checks. Lifty has no dated send evidence here, so this doesn't confirm recent sends.");
  return {
    source: source.source,
    campaign_ref: source.source === "smartlead_campaign" ? source.campaign_ref : null,
    connection_ref: source.source === "lifty_direct_email" ? source.connection_ref : null,
    provider: source.source === "smartlead_campaign" ? (/^[a-z][a-z0-9_-]{0,39}$/.test(source.provider) ? source.provider : "other") : "unipile",
    name: source.source === "smartlead_campaign" ? n(source.name) : null,
    sender_ref: source.source === "smartlead_campaign" ? n(source.sender_ref) : null,
    campaign_count: source.source === "smartlead_campaign" ? 1 : source.campaign_count,
    states, status, sending,
    provider_status: source.source === "smartlead_campaign" ? n(source.provider_status) : null,
    created_at: source.source === "smartlead_campaign" ? iso(ms(source.created_at)) : source.latest_created_at ? iso(ms(source.latest_created_at)) : null,
    last_synced_at: source.source === "smartlead_campaign" && source.last_synced_at ? iso(ms(source.last_synced_at)) : null,
    drift_detected_at: source.source === "smartlead_campaign" && source.drift_detected_at ? iso(ms(source.drift_detected_at)) : null,
  };
}

function presentCampaigns(items: Campaign[]): DeliverabilityMailbox["campaigns"] {
  const active = items.filter(item => item.status.code === "active");
  const enabled = active.filter(item => item.sending.code === "enabled");
  const blocked = active.filter(item => item.sending.code === "blocked");
  const unverified = active.filter(item => item.sending.code === "unverified");
  const name = (item: Campaign) => item.name ?? (item.source === "lifty_direct_email" ? "Direct Lifty campaigns" : "Unnamed campaign");
  let status: DeliverabilityMailbox["campaigns"]["status"];
  if (enabled.length > 0) status = make("in_campaign_enabled", `In ${plural(enabled.length, "active campaign")} · allowed`, "ok",
    "Configured on an active campaign and passing its send checks. Lifty has no dated send evidence here, so this doesn't confirm recent sends.",
    [...blocked, ...unverified].map(item => reason(`campaign_${item.sending.code}`, `${name(item)}: ${item.sending.description}`)));
  else if (blocked.length > 0) status = make("in_campaign_blocked", `In ${plural(blocked.length, "active campaign")} · blocked`, "bad",
    "Configured on an active campaign, but this inbox is blocked from sending.", blocked.flatMap(item => item.sending.reasons));
  else if (unverified.length > 0) status = make("unverified", "Campaign state unverified", "warn",
    "Configured on an active campaign, but whether this inbox may send couldn't be verified.", unverified.flatMap(item => item.sending.reasons));
  else if (items.some(item => item.status.code === "paused")) status = make("campaign_paused", "Campaign paused", "warn", "Every campaign using this inbox is paused.");
  else if (items.length > 0) status = make("no_campaign", "No active campaign", "muted", "This inbox is only on campaigns that are not active.");
  else status = make("no_campaign", "No campaign", "muted", "This inbox isn't configured on any campaign.");
  return { status, items };
}

// ------------------------------------------------ approval, recovery, status

function presentApproval(mailbox: SourceMailbox, now: Date): DeliverabilityMailbox["approval"] {
  const m = mailbox.smartlead;
  const hold = m?.placement_hold_reason ? { reason: m.placement_hold_reason, review_at: m.placement_hold_review_at ? iso(ms(m.placement_hold_review_at)) : null } : null;
  const common = { approved_at: m?.approved_at ? iso(ms(m.approved_at)) : null, approved_by: n(m?.approved_by),
    placement_gate_passed_at: m?.placement_gate_passed_at ? iso(ms(m.placement_gate_passed_at)) : null,
    cold_eligible_at: m?.cold_eligible_at ? iso(ms(m.cold_eligible_at)) : null, hold };
  const holdReason = hold ? [reason("placement_hold", `Placement testing is on hold: ${hold.reason}${hold.review_at ? ` (review ${day(hold.review_at)})` : ""}.`)] : [];
  if (!m) return { status: make("not_applicable", "No approval record", "muted", "This inbox has no LIFT approval record. Its send controls decide whether it may send."), ...common };
  if (m.approved_for_outbound) return { status: make("approved", "Approved", "ok",
    `Approved for outbound${m.approved_at ? ` on ${day(m.approved_at)}` : ""}${m.approved_by ? ` by ${m.approved_by}` : ""}. Approval alone doesn't enable sending; the other checks still apply.`, holdReason), ...common };
  const paused = Boolean(m.mitigation_state && m.mitigation_state !== "none");
  const ageDone = ms(m.cold_eligible_at) <= now.getTime();
  if (!paused && ageDone && m.placement_gate_passed_at) return { status: make("awaiting_approval", "Needs approval", "watch",
    "The warmup period and placement gate are done; only explicit human approval remains.", holdReason), ...common };
  const reasons: Reason[] = [...holdReason];
  if (!ageDone) reasons.push(reason("warmup_period_incomplete", m.cold_eligible_at ? `The warmup period ends ${day(m.cold_eligible_at)} (estimated).` : "The warmup period hasn't started counting."));
  if (!m.placement_gate_passed_at) reasons.push(reason("placement_gate_not_passed", "Hasn't passed the placement gate."));
  if (paused) reasons.push(reason("mitigation_paused", "Paused by deliverability mitigation."));
  return { status: make("not_approved", "Not approved", "muted", "Not approved for outbound yet.", reasons), ...common };
}

function presentRecovery(mailbox: SourceMailbox, now: Date): DeliverabilityMailbox["recovery"] {
  const m = mailbox.smartlead;
  if (!m || (m.mitigation_state !== "paused" && m.mitigation_state !== "retired")) return null;
  const pausedAt = ms(m.mitigation_paused_at);
  const base = { reason: n(m.mitigation_reason), paused_at: Number.isFinite(pausedAt) ? iso(pausedAt) : null,
    resumed_at: m.mitigation_resumed_at ? iso(ms(m.mitigation_resumed_at)) : null, rewarm_days: MITIGATION_REWARM_DAYS };
  if (m.mitigation_state === "retired") return { state: "retired", ...base, day: null, rewarm_complete_at: null,
    description: "Retired after a deliverability problem. Replace the domain; this inbox doesn't return to sending." };
  const dayNumber = Number.isFinite(pausedAt) ? Math.max(1, Math.floor((now.getTime() - pausedAt) / DAY) + 1) : null;
  return { state: "paused", ...base, day: dayNumber, rewarm_complete_at: Number.isFinite(pausedAt) ? iso(pausedAt + MITIGATION_REWARM_DAYS * DAY) : null,
    description: `Paused${m.mitigation_reason ? ` after ${words(m.mitigation_reason)}` : ""}. Warmup keeps running; after at least ${MITIGATION_REWARM_DAYS} days a clean placement test can resume sending. Approval is kept separately.` };
}

function presentIdentity(mailbox: SourceMailbox): DeliverabilityMailbox["identity"] {
  const names = mailbox.senders.map(sender => sender.name);
  if (mailbox.identity.status === "resolved") return make("resolved", names[0] ?? "Assigned", "ok", `This inbox belongs to ${names[0] ?? "one sender"}.`);
  if (mailbox.identity.status === "ambiguous_owner") return make("ambiguous_owner", "Owner unclear", "warn",
    "More than one sender claims this inbox. Nothing merges them automatically.", mailbox.senders.map(sender => reason("claimed_by", `${sender.name} (${sender.sender_ref})`)));
  return make("unassigned", "No sender", "muted", "No sender is assigned to this inbox.");
}

function presentStatus(parts: {
  recovery: DeliverabilityMailbox["recovery"]; placement: DeliverabilityMailbox["placement"]; campaigns: DeliverabilityMailbox["campaigns"];
  warmup: DeliverabilityMailbox["warmup"]; approval: DeliverabilityMailbox["approval"]; readiness: DeliverabilityMailbox["readiness"]; hasEvidence: boolean;
}): DeliverabilityMailbox["status"] {
  const { recovery, placement, campaigns, warmup, approval, readiness } = parts;
  if (recovery?.state === "retired") return make("retired", "Retired · replace domain", "bad", recovery.description);
  if (recovery?.state === "paused") {
    const label = recovery.day === null ? "Paused · recovering" : recovery.day <= recovery.rewarm_days
      ? `Paused · recovering (day ${recovery.day} of ${recovery.rewarm_days})` : "Paused · awaiting a clean re-test";
    return make("paused", label, "bad", recovery.description);
  }
  if (placement.status.code === "failed") return make("placement_failed", placement.status.label, "bad", placement.status.description, placement.status.reasons);
  if (campaigns.status.code === "in_campaign_blocked") return make("blocked_in_campaign", "In campaign · blocked", "bad", campaigns.status.description, campaigns.status.reasons);
  if (warmup.status.code === "problem") return make("warmup_problem", warmup.status.label, "warn", warmup.status.description, warmup.status.reasons);
  if (approval.status.code === "awaiting_approval") return make("needs_approval", "Needs approval", "watch", approval.status.description, approval.status.reasons);
  const ready = readiness.code === "ready" || readiness.code === "partially_ready";
  if (ready && placement.evidence.max_age_days !== null && (placement.status.code === "stale" || placement.status.code === "no_tests" || placement.status.code === "no_result")) {
    return make("placement_due", "Placement test due", "warn", placement.status.description, placement.status.reasons);
  }
  if (campaigns.status.code === "in_campaign_enabled") return make("in_campaign", "In campaign", "ok", campaigns.status.description, campaigns.status.reasons);
  if (ready) return make("ready_idle", "Ready · no active campaign", "watch", `${readiness.description} It isn't on an active campaign.`, readiness.reasons);
  const warming = warmup.sources.find(source => (source.state.code === "active" || source.state.code === "pending") && source.period_complete === false);
  if (warming) return make("warming", warmup.status.label, "muted", warmup.status.description, warmup.status.reasons);
  if (readiness.code === "no_known_blocker") return make("no_known_blocker", readiness.label, "watch", readiness.description, readiness.reasons);
  if (!parts.hasEvidence) return make("no_evidence", "No evidence yet", "muted", "No warmup, placement or registry evidence is recorded for this inbox yet. Missing evidence is not a healthy result.");
  return make("not_ready", "Not ready yet", "muted", readiness.description, readiness.reasons);
}

function presentMailbox(source: SourceMailbox, workspaces: Map<string, { slug: string; name: string }>, now: Date, detail: PlacementDetail[] | null): DeliverabilityMailbox {
  const connections = source.connections.map(connection => presentConnection(source, connection));
  const connected = new Set(connections.filter(item => item.status === "connected").map(item => item.provider));
  // A disconnected connection is history when the same provider has a live one.
  const connectionPaths = connections.filter(item => item.status === "connected" || !connected.has(item.provider))
    .map(item => ({ provider: item.provider, connection_ref: item.connection_ref, gate: item.gate, state: item.send_gate }));
  const smartlead = smartleadPath(source, now);
  const paths = [...(smartlead ? [smartlead] : []), ...connectionPaths];
  const readiness = presentReadiness(paths);
  const warmup = presentWarmup(source, now);
  const placement = presentPlacement(source, now, detail);
  const campaigns = presentCampaigns(source.campaigns.map(item => presentCampaign(item, paths)));
  const approval = presentApproval(source, now);
  const recovery = presentRecovery(source, now);
  const workspace = workspaces.get(source.workspace_ref);
  const unique = (values: string[]) => [...new Set(values)].slice(0, 5);
  return {
    mailbox_ref: source.mailbox_ref,
    workspace: { workspace_ref: source.workspace_ref, slug: workspace?.slug ?? null, name: workspace?.name ?? null },
    email: source.email, domain: source.domain,
    senders: source.senders.map(sender => ({ sender_ref: sender.sender_ref, name: sender.name, is_active: sender.is_active })),
    identity: presentIdentity(source),
    providers: {
      sending: unique([...(source.smartlead ? ["smartlead"] : []), ...connections.filter(item => item.status === "connected").map(item => item.provider)]),
      warmup: unique(warmup.sources.map(item => item.provider)),
      placement: unique([...placement.recent_tests, ...(placement.latest_completed_test ? [placement.latest_completed_test] : [])].map(test => test.provider)),
    },
    status: presentStatus({ recovery, placement, campaigns, warmup, approval, readiness,
      hasEvidence: Boolean(source.smartlead) || warmup.sources.length > 0 || source.placement.test_count > 0 }),
    readiness, warmup, recovery, campaigns, placement, approval,
    notes: { human: source.smartlead?.notes?.trim() || null },
    connections: connections.map(({ gate: _gate, ...connection }) => connection),
    availability: source.availability,
  };
}

// ---------------------------------------------------------- workspace health

const postureStates: Record<string, [string, Tone]> = {
  healthy: ["Healthy", "ok"], watch: ["Needs watching", "watch"], degraded: ["Degraded", "warn"], critical: ["Critical", "bad"],
  insufficient_data: ["Not enough sending data", "muted"],
};
const obj = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown) => typeof value === "string" ? value : null;
const pct = (value: unknown) => { const v = num(value); return v !== null && v >= 0 && v <= 100 ? v : null; };

function presentWorkspaceHealth(entry: DeliverabilitySource["workspace_health"][number]): DeliverabilityResponse["workspace_health"][number] {
  const posture = entry.posture ?? null;
  const aggregate = obj(posture?.metrics);
  const components = obj(aggregate?.componentHealth);
  const placement = obj(aggregate?.placement);
  const label = posture?.client_label || entry.name;
  const base = {
    workspace_ref: entry.workspace_ref, slug: entry.slug, name: entry.name,
    scope_note: `${label}-wide. This is workspace context, not a result for any one inbox.`.slice(0, 200),
    captured_at: posture ? iso(ms(posture.captured_at)) : null, source: n(posture?.source),
    components: { placement: str(components?.placement), live: str(components?.live), lifecycle: str(components?.lifecycle) },
    placement: { gmail_inbox_pct: pct(placement?.gmailInboxPct), office365_inbox_pct: pct(placement?.office365InboxPct),
      overall_spam_pct: pct(placement?.overallSpamPct), tested_at: str(placement?.testedAt) && Number.isFinite(ms(str(placement?.testedAt))) ? iso(ms(str(placement?.testedAt))) : null },
    sends: (() => { const v = num(aggregate?.sends); return v !== null && Number.isInteger(v) && v >= 0 ? v : null; })(),
  };
  if (!posture) return { ...base, status: make("none", "No workspace health yet", "muted", "No workspace health snapshot is recorded. Missing evidence is not a healthy result.") };
  const reasons = (Array.isArray(aggregate?.reasons) ? aggregate.reasons : []).filter((item): item is string => typeof item === "string").map(text => {
    const lower = text.toLowerCase();
    if (lower.includes("placement fail")) {
      const metrics = [base.placement.gmail_inbox_pct === null ? null : `Gmail ${base.placement.gmail_inbox_pct}% inbox`,
        base.placement.office365_inbox_pct === null ? null : `Outlook ${base.placement.office365_inbox_pct}% inbox`,
        base.placement.overall_spam_pct === null ? null : `${base.placement.overall_spam_pct}% spam`].filter(Boolean);
      return reason("workspace_placement_failed", `At least one placement test in this workspace failed${metrics.length > 0 ? `. Snapshot averages: ${metrics.join(" · ")}` : ""}.`);
    }
    if (lower.includes("no send volume")) return reason("no_send_volume", "No campaign send volume yet, so live bounce and complaint health is unavailable.");
    if (lower.includes("insufficient sends")) return reason("insufficient_sends", "Not enough campaign send volume yet to judge live bounce and complaint health.");
    return reason("workspace_reason", text);
  });
  const known = postureStates[posture.status];
  const status = known
    ? make(posture.status as "healthy", known[0], known[1], `Workspace health from the ${posture.source ?? "latest"} snapshot of ${day(posture.captured_at)}. It covers the whole workspace, not one inbox.`, reasons)
    : make("unknown", `Unknown workspace health (${posture.status})`.slice(0, 120), "bad", "The workspace health snapshot has an unrecognized status.", reasons);
  return { ...base, status };
}

// -------------------------------------------------------------- assembly

export interface PresentOptions {
  detail?: "placement" | null;
  details?: ReadonlyMap<string, PlacementDetail[]>;
  warnings?: DeliverabilityResponse["warnings"];
}

/** Maps the authorized database source to the public contract. Pure. */
export function presentDeliverability(source: DeliverabilitySource, now: Date, options: PresentOptions = {}): DeliverabilityResponse {
  const workspaces = new Map(source.filters.workspaces.map(item => [item.workspace_ref, { slug: item.slug, name: item.name }]));
  return DeliverabilityResponse.parse({
    schema_version: DELIVERABILITY_SCHEMA_VERSION,
    generated_at: iso(ms(source.generated_at)),
    scope: { kind: source.scope.kind, workspace_ref: n(source.scope.workspace_ref), workspace_slug: n(source.scope.workspace_slug) },
    query: { sender: n(source.query.sender), mailbox: n(source.query.mailbox), history_limit: source.query.history_limit, limit: source.query.limit,
      detail: options.detail ?? null },
    filters: {
      workspaces: source.filters.workspaces.map(({ workspace_ref, slug, name, is_active }) => ({ workspace_ref, slug, name, is_active })),
      senders: source.filters.senders, unassigned_count: source.filters.unassigned_count,
    },
    workspace_health: source.workspace_health.map(presentWorkspaceHealth),
    mailboxes: source.mailboxes.map(mailbox => presentMailbox(mailbox, workspaces, now,
      options.detail === "placement" ? options.details?.get(mailbox.mailbox_ref) ?? [] : null)),
    total_count: source.total_count,
    next_cursor: n(source.next_cursor),
    warnings: options.warnings ?? [],
  });
}

// ------------------------------------------------------------- operation

// Errors raised by public.deliverability_read (LIF-1041).
const rpcErrors: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in to LIFTY before reading deliverability." },
  deliverability_invalid_request: { status: 400, message: "Check the deliverability filters and try again." },
  deliverability_workspace_required: { status: 400, message: "Choose a workspace, or request the fleet explicitly." },
  deliverability_fleet_forbidden: { status: 403, message: "Only LIFT admins can read the whole fleet." },
  deliverability_workspace_forbidden: { status: 403, message: "Choose a workspace you belong to." },
  deliverability_sender_not_found: { status: 404, message: "That sender isn't in the workspaces you can read." },
  deliverability_mailbox_not_found: { status: 404, message: "That inbox isn't in the workspaces you can read." },
};

function unavailable(message = "LIFTY could not read deliverability. Retry shortly.") {
  return new PublicError({ status: 502, code: "DELIVERABILITY_UNAVAILABLE", message });
}

function mapRpcError(error: unknown): never {
  const parsed = z.object({ message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcErrors, message) ? rpcErrors[message] : undefined;
  if (!known) throw unavailable();
  throw new PublicError({ status: known.status, code: message === "unauthenticated" ? "UNAUTHORIZED" : message.toUpperCase(), message: known.message });
}

interface RpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }

export interface EmailDeliverabilityDependencies {
  now?: () => Date;
  /** Reads existing provider reports for authorized tests; absent reports every Smartlead detail as not configured. */
  readPlacementDetails?: PlacementReportReader;
}

export function createEmailDeliverabilityOperations(dependencies: EmailDeliverabilityDependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  return {
    async read(session: AuthSession, input: DeliverabilityQueryInput): Promise<DeliverabilityResponse> {
      const query = DeliverabilityQuery.parse(input);
      const { detail, ...rest } = query;
      const pQuery = Object.fromEntries(Object.entries(rest).filter(([key, value]) => value !== undefined && !(key === "scope" && value === "workspace")));
      let response: { data: unknown; error: unknown };
      // The caller's own session: the database authorizes scope, filters and cursor.
      try { response = await (session.client as RpcClient).rpc("deliverability_read", { p_query: pQuery }); }
      catch { throw unavailable(); }
      if (response.error) mapRpcError(response.error);
      const parsed = DeliverabilitySource.safeParse(response.data);
      if (!parsed.success) throw unavailable("LIFTY returned an invalid deliverability read. Retry shortly.");
      const source = parsed.data;
      // Defense in depth: every inbox must belong to the authorized scope the database reported.
      const scope = new Set(source.filters.workspaces.map(item => item.workspace_ref));
      if (source.scope.kind !== query.scope || source.mailboxes.some(mailbox => !scope.has(mailbox.workspace_ref))
        || (query.scope === "workspace" && source.filters.workspaces.length !== 1)) {
        throw unavailable("LIFTY returned an inconsistent deliverability read. Retry shortly.");
      }
      const warnings: DeliverabilityResponse["warnings"] = [];
      const details = new Map<string, PlacementDetail[]>();
      if (detail === "placement") {
        if (source.mailboxes.length !== 1) throw unavailable("LIFTY returned an inconsistent deliverability read. Retry shortly.");
        const mailbox = source.mailboxes[0]!;
        // Only authorized, completed tests; the newest few, never caller-chosen ids.
        const tests = mailbox.placement.recent_tests.filter(test => test.execution_status === "completed").slice(0, DELIVERABILITY_DETAIL_MAX_REPORTS);
        const read = dependencies.readPlacementDetails;
        const results = read ? await read(tests, mailbox.email) : tests.map(test => test.provider === "smartlead"
          ? { test_ref: test.test_ref, status: "not_configured" as const, message: "Provider placement reports are not configured on this server.", providers: [], auth: null, blacklisted: null }
          : { test_ref: test.test_ref, status: "no_report" as const, message: "This test stored no per-provider placement.", providers: [], auth: null, blacklisted: null });
        details.set(mailbox.mailbox_ref, results);
        for (const result of results) {
          if (result.status === "unavailable") warnings.push({ code: "placement_detail_unavailable", source: "smartdelivery", mailbox_ref: mailbox.mailbox_ref, message: result.message });
        }
        if (results.some(result => result.status === "not_configured")) {
          warnings.push({ code: "placement_detail_not_configured", source: "placement_detail", mailbox_ref: mailbox.mailbox_ref, message: "Provider placement reports are not configured on this server." });
        }
      }
      return presentDeliverability(source, now(), { detail: detail ?? null, details, warnings });
    },
  };
}
export type EmailDeliverabilityOperations = ReturnType<typeof createEmailDeliverabilityOperations>;
