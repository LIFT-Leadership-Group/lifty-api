import { resolveMx } from "node:dns/promises";
import type { PlacementDetail, SourceTest } from "./email-deliverability-contracts.js";

// LIF-1042: existing placement reports for one authorized inbox. Moved from the
// dashboard's SmartDelivery server action so the page and the CLI read the same
// detail. The inbox address and test ids always come from the authorized
// database read; this module never accepts caller-chosen test ids, never
// creates tests and never sends seeds.

const SMARTDELIVERY_API_BASE = "https://smartdelivery.smartlead.ai/api/v1";

export type SeedProvider = "gmail" | "outlook" | "other";
type SeedFolder = "inbox" | "spam" | "other" | "missing";
interface SeedPlacement {
  provider: SeedProvider;
  folder: SeedFolder;
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  blacklisted: boolean | null;
}

export interface PlacementReportSettings {
  /** Shared Smartlead credential; null reports every Smartlead detail as not configured. */
  smartleadApiKey: string | null;
  fetchImpl?: typeof fetch;
  resolveMailHost?: (domain: string) => Promise<string>;
  timeoutMs?: number;
}

/**
 * Classify a receiving provider from a mail-exchanger hostname. The report's
 * reply rDNS describes the sender, so the recipient seed domain's MX wins.
 */
export function classifySeedProvider(mailHost: string | null): SeedProvider {
  if (!mailHost) return "other";
  const host = mailHost.toLowerCase();
  if (host.includes("outlook") || host.includes("microsoft")) return "outlook";
  if (host.includes("google") || host.includes("gmail") || host.includes("1e100.net")) return "gmail";
  return "other";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function authStatus(result: unknown): boolean | null {
  const status = record(result)?.status;
  if (typeof status === "boolean") return status;
  if (typeof status === "string") return status.toUpperCase() === "PASS";
  return null;
}

/** The mailbox's row of a sender-account-wise report, or null when absent. */
function senderRow(payload: unknown, mailboxEmail: string): Record<string, unknown> | null {
  if (!Array.isArray(payload)) return null;
  const target = mailboxEmail.trim().toLowerCase();
  return payload.map(record).find(row => typeof row?.email === "string" && row.email.trim().toLowerCase() === target) ?? null;
}

function seedDomain(detail: Record<string, unknown>): string | null {
  const seed = typeof detail.email === "string" ? detail.email : "";
  const at = seed.lastIndexOf("@");
  return at >= 0 ? seed.slice(at + 1).trim().toLowerCase() || null : null;
}

/** Extract this mailbox's seed placements from a SmartDelivery sender-account-wise report. */
export function parseSenderAccountReport(payload: unknown, mailboxEmail: string,
  providersByDomain: ReadonlyMap<string, SeedProvider> = new Map()): SeedPlacement[] | null {
  const row = senderRow(payload, mailboxEmail);
  if (!row) return null;
  return (Array.isArray(row.details) ? row.details : []).map((raw): SeedPlacement => {
    const detail = record(raw) ?? {};
    const domain = seedDomain(detail);
    const receiving = domain ? providersByDomain.get(domain) : undefined;
    const reply = record(detail.reply);
    if (!reply) return { provider: receiving ?? "other", folder: "missing", spf: null, dkim: null, dmarc: null, blacklisted: null };
    const folderRaw = String(reply.mail_folder ?? "").toLowerCase();
    const folder: SeedFolder = folderRaw === "inbox" ? "inbox"
      : folderRaw === "spam" || folderRaw === "junk" ? "spam" : folderRaw ? "other" : "missing";
    const blacklist = record(reply.blacklist_status);
    const rdns = record(reply.rdns_result)?.rdns;
    return {
      provider: receiving ?? classifySeedProvider(rdns == null ? null : String(rdns)),
      folder,
      spf: authStatus(reply.spf_result), dkim: authStatus(reply.dkim_result), dmarc: authStatus(reply.dmarc_result),
      blacklisted: blacklist ? Number(blacklist.totalBlacklist ?? 0) > 0 : null,
    };
  });
}

export function summarizeSeeds(testRef: string, seeds: SeedPlacement[]): PlacementDetail {
  const providers = new Map<SeedProvider, { inbox: number; spam: number; other: number; missing: number; total: number }>();
  const auth = { spf: { pass: 0, total: 0 }, dkim: { pass: 0, total: 0 }, dmarc: { pass: 0, total: 0 } };
  let blacklisted: boolean | null = null;
  for (const seed of seeds) {
    const entry = providers.get(seed.provider) ?? { inbox: 0, spam: 0, other: 0, missing: 0, total: 0 };
    entry[seed.folder] += 1;
    entry.total += 1;
    providers.set(seed.provider, entry);
    for (const protocol of ["spf", "dkim", "dmarc"] as const) {
      if (seed[protocol] === null) continue;
      auth[protocol].total += 1;
      if (seed[protocol]) auth[protocol].pass += 1;
    }
    if (seed.blacklisted !== null) blacklisted = blacklisted === true || seed.blacklisted;
  }
  return {
    test_ref: testRef, status: "ok", message: "Seed placement from the provider's stored report.",
    providers: (["gmail", "outlook", "other"] as const).flatMap(provider => {
      const entry = providers.get(provider);
      return entry ? [{ provider, ...entry }] : [];
    }),
    auth, blacklisted,
  };
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Mailivery stores per-family samples on the request; missing fields stay unavailable, never zero. */
export function mailiveryDetail(test: SourceTest): PlacementDetail {
  const families = test.families ?? null;
  const breakdown = (provider: "gmail" | "outlook", sample: unknown) => {
    const counts = record(sample);
    return counts ? [{ provider, inbox: nullableCount(counts.inbox), spam: nullableCount(counts.spam), other: nullableCount(counts.other),
      missing: nullableCount(counts.missing), total: nullableCount(counts.total) }] : [];
  };
  const providers = families ? [...breakdown("gmail", families.gmail), ...breakdown("outlook", families.o365)] : [];
  return providers.length === 0
    ? { test_ref: test.test_ref, status: "no_report", message: "This test stored no per-provider placement.", providers: [], auth: null, blacklisted: null }
    : { test_ref: test.test_ref, status: "ok", message: "Per-provider placement stored with the test. Authentication and blacklist results are not recorded for this provider.",
      providers, auth: null, blacklisted: null };
}

const unavailable = (testRef: string, message: string): PlacementDetail =>
  ({ test_ref: testRef, status: "unavailable", message, providers: [], auth: null, blacklisted: null });

export function createPlacementReportReader(settings: PlacementReportSettings) {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const timeoutMs = settings.timeoutMs ?? 8_000;
  const resolveMailHost = settings.resolveMailHost
    ?? (async (domain: string) => (await resolveMx(domain)).map(entry => entry.exchange).join(" "));
  const providerCache = new Map<string, Promise<SeedProvider>>();
  const apiKey = settings.smartleadApiKey?.trim() || null;

  // Seed domains are the provider's fixed seed pool; unresolved domains count as "other".
  function seedProvider(domain: string): Promise<SeedProvider> {
    let provider = providerCache.get(domain);
    if (!provider) {
      provider = Promise.race([
        resolveMailHost(domain).then(classifySeedProvider),
        new Promise<SeedProvider>(resolve => setTimeout(() => resolve("other"), timeoutMs).unref?.()),
      ]).catch(() => "other" as const);
      providerCache.set(domain, provider);
    }
    return provider;
  }

  async function smartlead(test: SourceTest, mailboxEmail: string): Promise<PlacementDetail> {
    const id = test.provider_test_ref ?? "";
    if (!/^[0-9]{1,15}$/.test(id)) return unavailable(test.test_ref, "This test has no provider report reference.");
    if (!apiKey) return { test_ref: test.test_ref, status: "not_configured", message: "Provider placement reports are not configured on this server.", providers: [], auth: null, blacklisted: null };
    let payload: unknown;
    try {
      // The key stays server-side; never log or echo this URL.
      const response = await fetchImpl(`${SMARTDELIVERY_API_BASE}/spam-test/report/${id}/sender-account-wise?api_key=${encodeURIComponent(apiKey)}`,
        { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return unavailable(test.test_ref, `The provider report could not be read (status ${response.status}).`);
      payload = await response.json();
    } catch {
      return unavailable(test.test_ref, "The provider report did not respond in time.");
    }
    const provisional = parseSenderAccountReport(payload, mailboxEmail);
    if (!provisional || provisional.length === 0) {
      return { test_ref: test.test_ref, status: "no_report", message: "The provider has no report for this inbox in this test. Reports can expire.", providers: [], auth: null, blacklisted: null };
    }
    const row = senderRow(payload, mailboxEmail)!;
    const domains = [...new Set((Array.isArray(row.details) ? row.details : []).map(detail => seedDomain(record(detail) ?? {}))
      .filter((domain): domain is string => domain !== null && /^[a-z0-9.-]{1,253}$/.test(domain)))];
    const providers = new Map(await Promise.all(domains.map(async domain => [domain, await seedProvider(domain)] as const)));
    return summarizeSeeds(test.test_ref, parseSenderAccountReport(payload, mailboxEmail, providers)!);
  }

  /** Detail for the given authorized tests, in input order. */
  return async function readPlacementDetails(tests: SourceTest[], mailboxEmail: string): Promise<PlacementDetail[]> {
    return Promise.all(tests.map(test => test.provider === "smartlead" ? smartlead(test, mailboxEmail) : mailiveryDetail(test)));
  };
}
export type PlacementReportReader = ReturnType<typeof createPlacementReportReader>;
