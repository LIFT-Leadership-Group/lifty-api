import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presentDeliverability } from "../src/email-deliverability.js";
import {
  DeliverabilityQuery, DeliverabilityResponse, DeliverabilitySource,
  type DeliverabilityMailbox, type DeliverabilitySource as Source,
} from "../src/email-deliverability-contracts.js";

// Sources are real deliverability_read output for the LIF-1041 two-tenant
// fixture, captured at this instant (see tests/fixtures/email-deliverability).
const now = new Date("2026-09-29T19:52:59Z");
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/email-deliverability/${name}`, import.meta.url), "utf8"));
const source = (name = "source-member-a.json"): Source => DeliverabilitySource.parse(fixture(name));
const inbox = (response: { mailboxes: DeliverabilityMailbox[] }, email: string, slug = "fixture-a") => {
  const found = response.mailboxes.find(item => item.email === email && item.workspace.slug === slug);
  if (!found) throw new Error(`missing ${slug}/${email}`);
  return found;
};
/** Edits one source inbox; the captured JSON stays untouched. */
function withInbox(email: string, edit: (mailbox: Source["mailboxes"][number]) => void, name?: string): Source {
  const copy = structuredClone(source(name));
  const mailbox = copy.mailboxes.find(item => item.email === email)!;
  edit(mailbox);
  return copy;
}
const present = (value: Source = source()) => presentDeliverability(value, now);

describe("deliverability contract", () => {
  it("validates the versioned response and bounded query", () => {
    expect(DeliverabilityResponse.parse(present()).schema_version).toBe("email-deliverability.v1");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: 9 })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: "9" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", limit: "101" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: "3.5" })).toThrow();
    expect(DeliverabilityQuery.parse({ workspace: "lift", history_limit: "8" })).toMatchObject({ history_limit: 8, limit: 50, scope: "workspace" });
    expect(DeliverabilityQuery.parse({ workspace: "lift", sender: "unassigned" }).history_limit).toBe(3);
  });

  it("requires a workspace unless the fleet is requested, and one mailbox_ref for detail", () => {
    expect(() => DeliverabilityQuery.parse({})).toThrow(/workspace/);
    expect(DeliverabilityQuery.parse({ scope: "fleet" }).scope).toBe("fleet");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", detail: "placement" })).toThrow(/mailbox_ref/);
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", detail: "placement", mailbox: "a@b.test" })).toThrow(/mailbox_ref/);
    expect(DeliverabilityQuery.parse({ workspace: "lift", detail: "placement", mailbox: "6170c056-3dab-cbb8-9213-9440fa809c62" }).detail).toBe("placement");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", is_admin: "true" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", sender: "someone" })).toThrow();
  });

  it("matches the committed response fixtures", () => {
    expect(present()).toEqual(fixture("response-member-a.json"));
    expect(present(source("source-fleet-fixtures.json"))).toEqual(fixture("response-fleet-fixtures.json"));
  });

  it("keeps filters, paging and workspace health from the authorized source", () => {
    const response = present();
    expect(response.filters.senders.map(item => item.name)).toEqual(["Dana Smith", "Lee Park"]);
    expect(response.filters.unassigned_count).toBe(1);
    expect(response.workspace_health).toHaveLength(1);
    expect(response.workspace_health[0]!.scope_note).toMatch(/not a result for any one inbox/);
    expect(response.workspace_health[0]!.status).toMatchObject({ code: "watch", reasons: [{ message: "weekend warmup gap" }] });
    const page = present(source("source-page1.json"));
    expect(page.mailboxes).toHaveLength(2);
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const unassigned = present(source("source-unassigned.json"));
    expect(unassigned.mailboxes.map(item => item.email)).toEqual(["unassigned@a.test"]);
    expect(unassigned.mailboxes[0]!.identity.code).toBe("unassigned");
  });
});

describe("Smartlead inbox", () => {
  const mailbox = inbox(present(), "sl-only@a.test");

  it("shows the newest three attempts in stable order and the latest completed test", () => {
    expect(mailbox.placement.test_count).toBe(4);
    expect(mailbox.placement.recent_tests.map(test => test.test_ref)).toEqual(["smartlead:900004", "smartlead:900003", "smartlead:900002"]);
    expect(mailbox.placement.latest_test_ref).toBe("smartlead:900004");
    expect(mailbox.placement.latest_completed_test).toMatchObject({ test_ref: "smartlead:900004", execution_status: "completed", verdict: "pass", label: "Passed · 12/12 inbox" });
    expect(mailbox.placement.status).toMatchObject({ code: "passed", tone: "ok" });
    expect(mailbox.placement.evidence).toMatchObject({ freshness: "fresh", max_age_days: 10 });
  });

  it("separates warmup, approval, readiness and campaign activity", () => {
    expect(mailbox.warmup.status.label).toBe("Warming · initial period complete");
    expect(mailbox.warmup.sources[0]).toMatchObject({ provider: "smartlead", period_complete: true, estimated_completion: null, started_at_basis: "observed_activity" });
    expect(mailbox.warmup.trend.days).toHaveLength(30);
    expect(mailbox.approval.status.code).toBe("approved");
    expect(mailbox.readiness).toMatchObject({ code: "ready", paths: [{ gate: "smartlead_eligibility", state: { code: "allowed" } }] });
    expect(mailbox.campaigns.items.map(item => [item.name, item.status.code, item.sending.code]))
      .toEqual([["A active campaign", "active", "enabled"], ["A paused campaign", "paused", "not_active"]]);
    expect(mailbox.campaigns.status.code).toBe("in_campaign_enabled");
    expect(mailbox.campaigns.status.description).toMatch(/doesn't confirm recent sends/);
    expect(mailbox.status.code).toBe("in_campaign");
  });

  it("keeps human notes apart from generated explanations", () => {
    expect(mailbox.notes).toEqual({ human: "A human note" });
    expect(JSON.stringify({ ...mailbox, notes: null })).not.toContain("A human note");
  });
});

describe("Unipile and Mailivery inbox", () => {
  const mailbox = inbox(present(), "uni-only@a.test");

  it("keeps a pending newest attempt apart from the latest completed result outside the limit", () => {
    expect(mailbox.placement.recent_tests.map(test => [test.execution_status, test.verdict]))
      .toEqual([["pending", "unknown"], ["running", "unknown"], ["error", "unknown"]]);
    expect(mailbox.placement.recent_tests.map(test => test.test_ref)).not.toContain("mailivery:7001");
    expect(mailbox.placement.latest_completed_test).toMatchObject({ test_ref: "mailivery:7001", verdict: "pass" });
    expect(mailbox.placement.status.code).toBe("stale");
    expect(mailbox.placement.status.reasons).toEqual([expect.objectContaining({ code: "newer_test_in_progress" })]);
  });

  it("reports a technical failure as an execution error, never a placement failure", () => {
    const failed = mailbox.placement.recent_tests[2]!;
    expect(failed).toMatchObject({ test_ref: "mailivery:7002", execution_status: "error", verdict: "unknown", label: "Did not run",
      execution_reason: { code: "provider_error" } });
    expect(failed.execution_reason!.message).toMatch(/not a placement result/);
  });

  it("projects warmup completion as an estimate from verified active days", () => {
    expect(mailbox.warmup.sources[0]).toMatchObject({ provider: "mailivery", active_days: 10, required_days: 21, period_complete: false,
      outreach_unlocked: false, started_at_basis: "provider_evidence", estimated_completion: { on: "2026-10-10", at: null } });
    expect(mailbox.warmup.sources[0]!.estimated_completion!.basis).toMatch(/^Estimated/);
    expect(mailbox.warmup.status.label).toBe("Warming · day 10 of 21");
  });

  it("explains a blocked campaign with the effective control", () => {
    expect(mailbox.campaigns.status.code).toBe("in_campaign_blocked");
    expect(mailbox.campaigns.status.reasons).toEqual([{ code: "send_paused", message: "Sending is paused for all LIFT email." }]);
    expect(mailbox.connections[0]!.holds).toEqual([{ reason: "operator_hold", updated_at: expect.any(String) }]);
    expect(mailbox.status.code).toBe("blocked_in_campaign");
  });
});

describe("mixed providers, identity and missing evidence", () => {
  it("shows an inbox that sends through Unipile while Smartlead holds its evidence once", () => {
    const response = present();
    expect(response.mailboxes.filter(item => item.email === "mixed@a.test")).toHaveLength(1);
    const mixed = inbox(response, "mixed@a.test");
    expect(mixed.providers).toEqual({ sending: ["smartlead", "unipile"], warmup: ["smartlead"], placement: ["smartlead"] });
    expect(mixed.connections.map(item => item.status)).toEqual(["connected", "disconnected"]);
    // The disconnected connection is history next to a live one: listed, not a sending path.
    expect(mixed.readiness.paths.map(path => path.provider)).toEqual(["smartlead", "unipile"]);
    expect(mixed.recovery).toMatchObject({ state: "paused", reason: "placement_failed", rewarm_days: 14 });
    expect(mixed.status.code).toBe("paused");
  });

  it("reports today's sends as the send budget counts them, never as an estimate", () => {
    type SourceSending = NonNullable<Source["mailboxes"][number]["sending"]>;
    const sending = (edit: Partial<SourceSending> | null) => inbox(present(withInbox("uni-only@a.test", mailbox => {
      mailbox.sending = edit === null ? null : { ...mailbox.sending!, ...edit };
    })), "uni-only@a.test").sending;
    expect(sending({})).toMatchObject({ limit: 10, used_today: 4, remaining_today: 6, timezone: "America/New_York",
      resets_at: "2026-09-30T04:00:00.000Z", state: { code: "available", tone: "ok", label: "6 of 10 left today" } });
    expect(sending({ used: 10, available: 0 })).toMatchObject({ used_today: 10, remaining_today: 0, state: { code: "limit_reached", tone: "warn" } });
    expect(sending({ ambiguous: true }).state).toMatchObject({ code: "available", tone: "watch", reasons: [{ code: "send_unconfirmed" }] });
    // An older database or an uncounted inbox is unknown, never zero sends.
    expect(sending(null)).toMatchObject({ limit: null, used_today: null, state: { code: "unknown", description: expect.stringMatching(/not zero sends/) } });
    expect(sending({ used: null, available: null })).toMatchObject({ limit: 10, used_today: null, state: { code: "unknown" } });
    // A mailbox shared with another workspace never shows that tenant's sends.
    expect(sending({ shared: true, used: 3, available: 7 })).toMatchObject({ limit: 10, used_today: null, remaining_today: null, state: { code: "unknown" } });
    expect(sending({ limit: null })).toMatchObject({ limit: null, used_today: null, state: { code: "not_set" } });
  });

  it("never merges the same address across tenants", () => {
    const fleet = present(source("source-fleet-fixtures.json"));
    const a = inbox(fleet, "mixed@a.test", "fixture-a");
    const b = inbox(fleet, "mixed@a.test", "fixture-b");
    expect(a.mailbox_ref).not.toBe(b.mailbox_ref);
    expect(b.placement.recent_tests.map(test => test.name)).toEqual(["LIFTY B secret"]);
    expect(a.placement.recent_tests.map(test => test.name)).not.toContain("LIFTY B secret");
  });

  it("marks ambiguous and unassigned owners explicitly", () => {
    const response = present();
    expect(inbox(response, "shared@a.test").identity).toMatchObject({ code: "ambiguous_owner", reasons: [{ code: "claimed_by" }, { code: "claimed_by" }] });
    expect(inbox(response, "unassigned@a.test").identity.code).toBe("unassigned");
  });

  it("never reads missing evidence as healthy", () => {
    const mailbox = inbox(present(), "unassigned@a.test");
    expect(mailbox.warmup.status).toMatchObject({ code: "none", label: "No warmup evidence" });
    expect(mailbox.placement.status).toMatchObject({ code: "no_tests", tone: "warn" });
    expect(mailbox.placement.evidence.freshness).toBe("unknown");
    const empty = present(withInbox("unassigned@a.test", item => { item.smartlead = null; item.availability.smartlead_registry = false; }));
    expect(inbox(empty, "unassigned@a.test")).toMatchObject({ status: { code: "no_evidence" }, readiness: { code: "unknown" } });
  });

  it("never presents a completed test without a verdict as passed", () => {
    const response = present(withInbox("sl-only@a.test", item => {
      item.placement.recent_tests[0]!.passed = null;
      item.placement.latest_completed_test!.passed = null;
    }));
    const mailbox = inbox(response, "sl-only@a.test");
    expect(mailbox.placement.latest_completed_test).toMatchObject({ verdict: "unknown", label: "Completed · no verdict" });
    expect(mailbox.placement.status.code).toBe("no_result");
    expect(mailbox.status.code).not.toBe("in_campaign");
  });

  it("marks an old passing result as stale and due", () => {
    const response = presentDeliverability(source(), new Date("2026-10-12T00:00:00Z"));
    const mailbox = inbox(response, "sl-only@a.test");
    expect(mailbox.placement.status.code).toBe("stale");
    expect(mailbox.placement.evidence.freshness).toBe("stale");
  });
});

describe("send gates by workspace owner", () => {
  const managed = (by: "lift" | "lifty", edit: (mailbox: Source["mailboxes"][number]) => void = () => {}) =>
    inbox(present(withInbox("uni-only@a.test", item => { item.workspace_managed_by = by; edit(item); })), "uni-only@a.test");

  it("treats LIFT send controls as the canonical Unipile gate", () => {
    expect(inbox(present(), "uni-only@a.test").readiness.paths).toEqual([expect.objectContaining({ gate: "lift_send_controls", state: expect.objectContaining({ code: "blocked" }) })]);
    const allowed = managed("lift", item => { item.connections[0]!.send_block_reason = null; });
    expect(allowed.readiness).toMatchObject({ code: "ready", paths: [{ gate: "lift_send_controls", state: { code: "allowed" } }] });
    expect(allowed.campaigns.status.code).toBe("in_campaign_enabled");
    const blocked = managed("lift", item => { item.connections[0]!.send_block_reason = "sender_mailbox_ineligible"; });
    expect(blocked.readiness.reasons[0]!.message).toMatch(/warmup and placement checks/);
  });

  it("does not claim readiness when the governing gate is unknown", () => {
    // The first deliverability-source.v1 release had no workspace_managed_by.
    const unknown = inbox(present(withInbox("uni-only@a.test", item => { delete item.workspace_managed_by; item.connections[0]!.send_block_reason = null; })), "uni-only@a.test");
    expect(unknown.readiness.code).toBe("unknown");
    expect(unknown.campaigns.status.code).toBe("unverified");
  });

  it("does not apply LIFT's placement freshness rule to Lifty inboxes", () => {
    const lifty = managed("lifty");
    expect(lifty.placement.evidence).toMatchObject({ max_age_days: null, freshness: "unknown" });
    expect(lifty.placement.evidence.rule).toMatch(/No placement freshness rule is known/);
    expect(managed("lift").placement.evidence).toMatchObject({ max_age_days: 10, freshness: "stale" });
  });

  it("keeps optional personal warmup from blocking Lifty inboxes", () => {
    const personal = managed("lifty", item => { item.connections[0]!.mailbox_use = "personal"; item.connections[0]!.holds = []; item.connections[0]!.send_block_reason = null; });
    expect(personal.warmup.sources[0]).toMatchObject({ required_days: null, period_complete: null, outreach_unlocked: null, estimated_completion: null });
    expect(personal.readiness).toMatchObject({ code: "no_known_blocker", paths: [{ gate: "lifty_campaign_checks" }] });
    const outreach = managed("lifty", item => { item.connections[0]!.mailbox_use = "outreach"; item.connections[0]!.holds = []; });
    expect(outreach.readiness.reasons.map(item => item.code)).toEqual(["warmup_required"]);
    const undeclared = managed("lifty", item => { item.connections[0]!.holds = []; });
    expect(undeclared.readiness.reasons.map(item => item.code)).toEqual(["mailbox_use_required"]);
  });
});

describe("warmup states", () => {
  const mailivery = (edit: (item: Source["mailboxes"][number]["warmup"]["mailivery"][number]) => void) =>
    inbox(present(withInbox("uni-only@a.test", item => edit(item.warmup.mailivery[0]!))), "uni-only@a.test").warmup;

  it("distinguishes paused, pending consent, rewarming and stale evidence", () => {
    expect(mailivery(item => { item.binding!.state = "paused"; }).status).toMatchObject({ code: "paused" });
    const consent = mailivery(item => { item.binding!.state = "pending_consent"; });
    expect(consent.status).toMatchObject({ code: "pending", reasons: [{ code: "microsoft_consent_pending" }] });
    const dns = mailivery(item => { item.binding!.state = "pending_consent"; item.binding!.blocking_reason = "dns_invalid_dmarc"; });
    expect(dns.status).toMatchObject({ code: "pending", label: "Waiting for valid DNS records",
      reasons: [{ code: "dns_invalid_dmarc", message: expect.stringMatching(/no valid DMARC record/) }] });
    expect(mailivery(item => { item.binding!.requested_action = "resume"; item.binding!.state = "paused"; }).status.reasons)
      .toEqual([{ code: "resume_requested", message: "Resuming warmup at the next check." }]);
    const stale = mailivery(item => { item.evidence!.observed_at = "2026-09-27T00:00:00Z"; });
    expect(stale.sources[0]!.last_check.freshness).toBe("stale");
    expect(stale.status.reasons.map(item => item.code)).toContain("warmup_check_stale");
  });

  it("keeps a completed period separate from campaign readiness", () => {
    const done = mailivery(item => { item.evidence!.active_duration_days = 25; });
    expect(done.sources[0]).toMatchObject({ period_complete: true, outreach_unlocked: false, estimated_completion: null });
    expect(done.status.label).toBe("Warming · initial period complete");
    expect(done.status.description).toMatch(/does not enable campaigns/);
  });

  it("explains when an approved inbox's period counts from the registry start", () => {
    const restarted = inbox(present(withInbox("sl-only@a.test", item => {
      item.warmup.smartlead!.active_since = "2026-09-15T19:00:00Z";
    })), "sl-only@a.test");
    expect(restarted.warmup.sources[0]).toMatchObject({ active_days: 14, required_days: 21, period_complete: true });
    expect(restarted.warmup.status.reasons).toEqual([expect.objectContaining({ code: "period_counted_from_registry",
      message: expect.stringMatching(/registry warmup start, 2026-08-20\. The current run of continuous warmup activity began 2026-09-15\./) })]);
    // A full run needs no explanation.
    expect(inbox(present(), "sl-only@a.test").warmup.status.reasons).toEqual([]);
  });

  it("reports Smartlead activity gaps and inactive warmup", () => {
    const mixed = inbox(present(), "mixed@a.test");
    expect(mixed.warmup.sources[0]!.state.reasons.map(item => item.code)).toEqual(["warmup_activity_low"]);
    const off = inbox(present(withInbox("sl-only@a.test", item => { item.warmup.smartlead!.status = "inactive"; })), "sl-only@a.test");
    expect(off.warmup.status.code).toBe("not_running");
  });

  it("counts mitigation recovery days on the rewarm clock", () => {
    const paused = (at: string) => inbox(present(withInbox("mixed@a.test", item => { item.smartlead!.mitigation_paused_at = at; })), "mixed@a.test");
    expect(paused("2026-09-25T10:00:00Z")).toMatchObject({ recovery: { day: 5 }, status: { label: "Paused · recovering (day 5 of 14)" } });
    expect(paused("2026-09-01T10:00:00Z").status.label).toBe("Paused · awaiting a clean re-test");
  });
});

describe("campaign states", () => {
  it("never confirms an active campaign that drifted from the provider", () => {
    const drift = inbox(present(withInbox("sl-only@a.test", item => {
      const campaign = item.campaigns[0]!;
      if (campaign.source === "smartlead_campaign") campaign.drift_detected_at = "2026-09-28T00:00:00Z";
    })), "sl-only@a.test");
    expect(drift.campaigns.items[0]!.sending).toMatchObject({ code: "unverified", reasons: [{ code: "drift_detected" }] });
    expect(drift.campaigns.status.code).toBe("unverified");
  });

  it("reports paused-only and inactive-only campaigns", () => {
    expect(inbox(present(), "shared@a.test").campaigns.status.code).toBe("campaign_paused");
    const archived = inbox(present(withInbox("shared@a.test", item => {
      const campaign = item.campaigns[0]!;
      if (campaign.source === "smartlead_campaign") campaign.status = "archived";
    })), "shared@a.test");
    expect(archived.campaigns.status).toMatchObject({ code: "no_campaign", label: "No active campaign" });
  });
});
