import { describe, expect, it } from "vitest";
import {
  classifySeedProvider, createPlacementReportReader, mailiveryDetail, parseSenderAccountReport, summarizeSeeds,
} from "../src/email-deliverability-placement.js";
import type { SourceTest } from "../src/email-deliverability-contracts.js";

const key = "smartlead-KEY-secret-value-0123456789";
const test = (overrides: Partial<SourceTest> = {}): SourceTest => ({
  provider: "smartlead", test_ref: "smartlead:900004", provider_test_ref: "900004", source: "smartlead_result",
  execution_status: "completed", passed: true, tested_at: "2026-09-27T19:34:38Z", ...overrides,
});
const reply = (folder: string, extra: Record<string, unknown> = {}) => ({
  mail_folder: folder, spf_result: { status: "PASS" }, dkim_result: { status: true }, dmarc_result: { status: "FAIL" },
  blacklist_status: { totalBlacklist: 0 }, rdns_result: { rdns: "mail-sor-f41.google.com" }, ...extra,
});
const report = [
  { email: "other@a.test", details: [{ email: "seed@gmail-seeds.test", reply: reply("spam") }] },
  { email: "SL-Only@a.test", details: [
    { email: "seed1@gmail-seeds.test", reply: reply("INBOX") },
    { email: "seed2@outlook-seeds.test", reply: reply("junk", { blacklist_status: { totalBlacklist: 2 } }) },
    { email: "seed3@outlook-seeds.test", reply: null },
    { email: "seed4@other-seeds.test", reply: reply("Promotions", { rdns_result: { rdns: "mx.other.test" } }) },
  ] },
];
const mx: Record<string, string> = { "gmail-seeds.test": "aspmx.l.google.com", "outlook-seeds.test": "x.mail.protection.outlook.com" };

function reader(options: { key?: string | null; respond?: (url: string) => Response | Promise<Response> } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const read = createPlacementReportReader({
    smartleadApiKey: options.key === undefined ? key : options.key,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return options.respond ? options.respond(String(url)) : Response.json(report); },
    resolveMailHost: async domain => { if (!mx[domain]) throw new Error("no mx"); return mx[domain]!; },
    timeoutMs: 50,
  });
  return { read, calls };
}

describe("SmartDelivery report parsing", () => {
  it("classifies receiving providers by the seed domain's MX, not the sender rDNS", () => {
    expect(classifySeedProvider("x.mail.protection.outlook.com")).toBe("outlook");
    expect(classifySeedProvider("aspmx.l.google.com")).toBe("gmail");
    expect(classifySeedProvider(null)).toBe("other");
    const seeds = parseSenderAccountReport(report, "sl-only@a.test", new Map([["outlook-seeds.test", "outlook" as const]]))!;
    // Without an MX answer the gmail seed falls back to the reply rDNS.
    expect(seeds.map(seed => [seed.provider, seed.folder])).toEqual([["gmail", "inbox"], ["outlook", "spam"], ["outlook", "missing"], ["other", "other"]]);
    expect(parseSenderAccountReport(report, "absent@a.test")).toBeNull();
    expect(parseSenderAccountReport({ not: "an array" }, "sl-only@a.test")).toBeNull();
  });

  it("summarizes folders, authentication and blacklists per provider", () => {
    const seeds = parseSenderAccountReport(report, "sl-only@a.test", new Map([["gmail-seeds.test", "gmail" as const], ["outlook-seeds.test", "outlook" as const]]))!;
    expect(summarizeSeeds("smartlead:1", seeds)).toEqual({
      test_ref: "smartlead:1", status: "ok", message: expect.any(String),
      providers: [
        { provider: "gmail", inbox: 1, spam: 0, other: 0, missing: 0, total: 1 },
        { provider: "outlook", inbox: 0, spam: 1, other: 0, missing: 1, total: 2 },
        { provider: "other", inbox: 0, spam: 0, other: 1, missing: 0, total: 1 },
      ],
      auth: { spf: { pass: 3, total: 3 }, dkim: { pass: 3, total: 3 }, dmarc: { pass: 0, total: 3 } },
      blacklisted: true,
    });
  });
});

describe("placement report reader", () => {
  it("reads only the stored report for the authorized test and keeps the key server-side", async () => {
    const h = reader();
    const [detail] = await h.read([test()], "sl-only@a.test");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toMatch(/^https:\/\/smartdelivery\.smartlead\.ai\/api\/v1\/spam-test\/report\/900004\/sender-account-wise\?api_key=/);
    expect(h.calls[0]!.init?.method).toBe("GET");
    expect(detail).toMatchObject({ status: "ok", providers: [{ provider: "gmail", inbox: 1 }, { provider: "outlook", spam: 1, missing: 1 }, { provider: "other", other: 1 }] });
    expect(JSON.stringify(detail)).not.toContain(key);
  });

  it("never calls the provider without a key or a numeric test id", async () => {
    const unconfigured = reader({ key: null });
    expect((await unconfigured.read([test()], "sl-only@a.test"))[0]!.status).toBe("not_configured");
    expect(unconfigured.calls).toHaveLength(0);
    const h = reader();
    expect((await h.read([test({ provider_test_ref: "../create" })], "sl-only@a.test"))[0]!.status).toBe("unavailable");
    expect(h.calls).toHaveLength(0);
  });

  it("turns provider errors and timeouts into per-test unavailability", async () => {
    const failed = reader({ respond: () => new Response("nope", { status: 500 }) });
    expect((await failed.read([test()], "sl-only@a.test"))[0]).toMatchObject({ status: "unavailable", message: expect.stringMatching(/status 500/) });
    const slow = reader({ respond: () => { throw new DOMException("timeout", "TimeoutError"); } });
    expect((await slow.read([test()], "sl-only@a.test"))[0]).toMatchObject({ status: "unavailable" });
    const missing = reader({ respond: () => Response.json([]) });
    expect((await missing.read([test()], "sl-only@a.test"))[0]!.status).toBe("no_report");
  });

  it("normalizes stored Mailivery samples without inventing zeros", async () => {
    const h = reader();
    const mailivery = test({ provider: "mailivery", test_ref: "mailivery:7001", provider_test_ref: "7001", source: "lifty_request",
      families: { gmail: { inbox: 2, total: 2 }, o365: { inbox: 1, spam: 1, total: 2, missing: 0 } } });
    const [detail] = await h.read([mailivery], "uni-only@a.test");
    expect(h.calls).toHaveLength(0);
    expect(detail).toMatchObject({ status: "ok", auth: null, blacklisted: null, providers: [
      { provider: "gmail", inbox: 2, spam: null, other: null, missing: null, total: 2 },
      { provider: "outlook", inbox: 1, spam: 1, other: null, missing: 0, total: 2 },
    ] });
    expect(mailiveryDetail(test({ provider: "mailivery", families: null })).status).toBe("no_report");
  });
});
