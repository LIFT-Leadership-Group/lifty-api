import { describe, expect, it } from "vitest";
import type { AccountProviderSettings } from "../src/account-provider.js";
import { withConnectionDeadline } from "../src/connection-confirmation.js";
import { createWarmupMailboxIdentifier } from "../src/warmup-mailbox-provider.js";
import type { UnipileTransport } from "../src/unipile-transport.js";

const email = "owner@business.test";
const settings: AccountProviderSettings = {
  v2: { accessToken: "v2-secret", applicationId: "app_test", hostedAuthOrigins: ["https://connect.lifty.test"] },
  v1: { accessToken: "v1-secret", dsn: "https://api1.unipile.com:13111", providerNamespace: "organization-scope" },
};
const v1: UnipileTransport = {
  api_version: "v1", connection_ref: "13850000-0000-4000-8000-000000000001",
  canonical_account_id: "legacy_mailbox", account_id: "legacy_mailbox", provider_namespace: "organization-scope",
  application_id: null, account_scope_id: null, user_id: null, owner_profile_id: null, v1_account_id: null,
  generation: 0, hosted_auth_origin: "https://account.unipile.com",
};
const v2: UnipileTransport = { ...v1, api_version: "v2", account_id: "acc_test", application_id: "app_test",
  account_scope_id: "scope_test", user_id: "owner", v1_account_id: "legacy_mailbox", hosted_auth_origin: "https://connect.lifty.test" };
const account = { object: "Account", id: "legacy_mailbox", type: "GOOGLE_OAUTH",
  connection_params: { mail: { id: "owner-id", username: email } },
  sources: [{ id: "source-a", status: "OK" }, { id: "source-b", status: "OK" }],
};
const owner = { object: "AccountOwnerProfile", provider: "GMAIL", email,
  aliases: [{ email, is_primary: true }, { email: "alias@business.test", is_primary: false }] };
const outlookOwner = { object: "AccountOwnerProfile", provider: "OUTLOOK", id: "owner-id", email };
const v2Account = { object: "Account", id: "acc_test", application_id: "app_test", account_scope_id: "scope_test",
  user_id: "owner", provider: "google", status: "running", is_locked: false,
  metadata: { v1_account_id: "legacy_mailbox", products_connection_status: { gmail: "running" } } };
const senders = { data: [{ object: "EmailSender", email, is_primary: true, verification_status: "verified" }] };
const required = { status: 409, code: "WARMUP_CONNECTION_REQUIRED" };
const pending = { status: 503, code: "WARMUP_VERIFICATION_PENDING" };
function harness(options: { account?: unknown; owner?: unknown; senders?: unknown; settings?: Partial<AccountProviderSettings>;
  fetch?: typeof fetch } = {}) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (options.fetch) return options.fetch(input, init);
    return Response.json(url.pathname.endsWith("users/me") ? options.owner ?? owner
      : url.pathname.endsWith("email-senders") ? options.senders ?? senders
      : options.account ?? account);
  };
  return { calls, identify: createWarmupMailboxIdentifier({ ...settings, ...options.settings, fetchImpl }) };
}

describe("warmup provider identification across retained and current transports", () => {
  it.each([
    ["GOOGLE_OAUTH", owner, "google"], ["OUTLOOK", outlookOwner, "microsoft"],
  ] as const)("preserves existing V1 %s own-mailbox warmup without a reconnect", async (type, profile, provider) => {
    const f = harness({ account: { ...account, type }, owner: profile });
    expect(await f.identify(v1, email)).toBe(provider);
    expect(f.calls.map(call => call.url.toString())).toEqual([
      "https://api1.unipile.com:13111/api/v1/accounts/legacy_mailbox",
      "https://api1.unipile.com:13111/api/v1/users/me?account_id=legacy_mailbox",
    ]);
    for (const call of f.calls) {
      expect(call.init).toMatchObject({ method: "GET", redirect: "error", headers: { "X-API-KEY": "v1-secret" } });
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it.each(["google", "outlook"])("uses V2 primary %s proof, with identical domains", async provider => {
    const f = harness({ account: { ...v2Account, provider, oauth_scope: "User.Read,Mail.ReadWrite,Mail.Send",
      metadata: { ...v2Account.metadata, products_connection_status: { [provider === "google" ? "gmail" : "outlook"]: "running" } } } });
    expect(await f.identify(v2, email)).toBe(provider === "outlook" ? "microsoft" : "google");
    expect(f.calls.map(call => call.url.toString())).toEqual([
      "https://api.unipile.com/v2/accounts/acc_test", "https://api.unipile.com/v2/acc_test/email-senders",
    ]);
    expect(f.calls.every(call => (call.init?.headers as Record<string, string>)["X-API-KEY"] === "v2-secret")).toBe(true);
  });
  it("accepts case differences, without merging aliases, dots or plus-tags", async () => {
    expect(await harness({ owner: { ...owner, email: email.toUpperCase(), aliases: [{ email: email.toUpperCase(), is_primary: true }] } }).identify(v1, email)).toBe("google");
    await expect(harness().identify(v1, "owner+alias@business.test")).rejects.toMatchObject(required);
  });
  it.each([
    { provider_namespace: "other-organization" }, { provider_namespace: "api1.unipile.com:13111" },
    { canonical_account_id: "different-account" }, { account_id: null }, { canonical_account_id: null },
    { application_id: "app_test" }, { account_scope_id: "scope_test" }, { user_id: "owner" },
    { v1_account_id: "legacy_mailbox" }, { owner_profile_id: "owner" },
  ])("rejects an unpinned or foreign V1 transport before provider access: %j", async patch => {
    const f = harness();
    await expect(f.identify({ ...v1, ...patch }, email)).rejects.toMatchObject(required);
    expect(f.calls).toHaveLength(0);
  });
  it.each([null, { dsn: "https://api1.unipile.com:13111", accessToken: "v1-secret" }])("keeps missing V1 configuration pending without inventing a namespace", async config => {
    const f = harness({ settings: { v1: config } });
    await expect(f.identify(v1, email)).rejects.toMatchObject(pending);
    expect(f.calls).toHaveLength(0);
  });
  it("allows DSN rotation only with the same configured organization namespace", async () => {
    const f = harness({ settings: { v1: { ...settings.v1!, dsn: "https://api2.unipile.com:13222" } } });
    expect(await f.identify(v1, email)).toBe("google");
    expect(f.calls[0]?.url.origin).toBe("https://api2.unipile.com:13222");
  });
  it.each([
    "http://api1.unipile.com", "https://evil.test", "https://api1.unipile.com/foreign", "https://key@api1.unipile.com",
    "https://api1.unipile.com?token=secret", "https://api1.unipile.com#foreign",
  ])("rejects unsafe configured V1 origins: %s", dsn => {
    expect(() => harness({ settings: { v1: { ...settings.v1!, dsn } } })).toThrow("Invalid Unipile V1 configuration");
  });
  it.each([
    { id: "foreign" }, { type: "MAIL" }, { type: "LINKEDIN" },
    { connection_params: { mail: { id: "owner-id", username: "foreign@business.test" } } },
    { type: "OUTLOOK", connection_params: { mail: { ...account.connection_params.mail, mailbox_id: "delegated" } } },
    ...["CREDENTIALS", "ERROR", "STOPPED", "PERMISSIONS"].map(status => ({ sources: [{ id: "source-a", status }] })),
  ])("refuses unsupported, foreign, delegated or unhealthy V1 mailbox evidence: %j", async patch => {
    const f = harness({ account: { ...account, ...patch } });
    await expect(f.identify(v1, email)).rejects.toMatchObject(required);
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    { ...owner, email: "foreign@business.test" }, { ...owner, aliases: [] },
    { ...owner, aliases: [{ email: "alias@business.test", is_primary: true }, { email, is_primary: false }] },
    { ...owner, aliases: [{ email, is_primary: true }, { email, is_primary: true }] },
    { ...owner, aliases: [{ email, is_default: true }] }, outlookOwner,
  ])("requires Google's authenticated primary instead of a profile alias: %j", async profile => {
    await expect(harness({ owner: profile }).identify(v1, email)).rejects.toMatchObject(required);
  });
  it("rejects another Outlook owner without falling back to mail.username", async () => {
    await expect(harness({ account: { ...account, type: "OUTLOOK" }, owner: { ...outlookOwner, email: "foreign@business.test" } })
      .identify(v1, email)).rejects.toMatchObject(required);
  });
  it.each([
    { account_scope_id: "scope_foreign" }, { application_id: "app_foreign" }, { user_id: "other-owner" },
    { id: "acc_other" }, { metadata: { v1_account_id: "other-account" } }, { provider: "imap" }, { is_locked: true },
  ])("retains the V2 application/scope/owner and primary policy: %j", async patch => {
    await expect(harness({ account: { ...v2Account, ...patch } }).identify(v2, email)).rejects.toMatchObject(required);
  });
  it("requires Outlook mail grants and a verified primary on V2", async () => {
    await expect(harness({ account: { ...v2Account, provider: "outlook", oauth_scope: "User.Read,Calendars.ReadWrite" } }).identify(v2, email)).rejects.toMatchObject(required);
    await expect(harness({ account: v2Account, senders: { data: [{ ...senders.data[0], verification_status: "unknown" }] } }).identify(v2, email)).rejects.toMatchObject(required);
  });
  it.each([
    { object: "unknown" }, { sources: [] }, { sources: [{ id: "", status: "OK" }] },
    { sources: [{ id: "duplicate", status: "OK" }, { id: "duplicate", status: "OK" }] },
    { sources: [{ id: "source-a", status: "CONNECTING" }] },
    { connection_params: undefined },
  ])("leaves incomplete or settling V1 evidence unknown: %j", async patch => {
    await expect(harness({ account: { ...account, ...patch } }).identify(v1, email)).rejects.toMatchObject(pending);
  });
  it.each([v1, v2])("sanitizes upstream errors and invalid/oversized responses without provider selection: $api_version", async transport => {
    for (const respond of [
      () => new Response("private-provider-body", { status: 503 }),
      () => new Response("private-provider-body", { status: 403 }),
      () => new Response("private-provider-body", { status: 200 }),
      () => new Response("x".repeat(1_048_577)),
    ]) {
      const f = harness({ fetch: async () => respond() });
      await expect(f.identify(transport, email)).rejects.toMatchObject(pending);
      await expect(f.identify(transport, email)).rejects.not.toHaveProperty("message", expect.stringContaining("private-provider-body"));
    }
  });
  it("bounds a stalled V1 response body and cancels the stream", async () => {
    let canceled = false;
    const f = harness({ settings: { timeoutMs: 10 }, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"object":')); },
      cancel() { canceled = true; },
    })) });
    await expect(f.identify(v1, email)).rejects.toMatchObject(pending);
    expect(canceled).toBe(true);
  });
  it("inherits the shared confirmation deadline for V1 provider requests", async () => {
    let aborted = false;
    const f = harness({ settings: { timeoutMs: 1000 }, fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private-provider-body")); }, { once: true });
    }) });
    await expect(withConnectionDeadline(10, () => f.identify(v1, email))).rejects.toMatchObject(pending);
    expect(aborted).toBe(true);
  });
});
