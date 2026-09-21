import { z } from "zod";
import { PublicError } from "./errors.js";
import { parseHostedAuthOrigin } from "./hosted-auth-branding.js";
import { ProviderIdentifier, type UnipileTransport, type VerifiedTransport } from "./unipile-transport.js";
import type { LinkedinIdentity } from "./linkedin-provider.js";

export interface UnipileV2Settings {
  accessToken: string;
  applicationId: string;
  /** Include earlier verified domains until every outstanding link has expired. */
  hostedAuthOrigins: string[];
}
const Account = z.object({
  object: z.literal("Account"), id: ProviderIdentifier, application_id: ProviderIdentifier,
  account_scope_id: ProviderIdentifier.nullish(), user_id: z.string().min(1).max(255),
  provider: z.enum(["linkedin", "google", "outlook", "imap"]),
  status: z.enum(["running", "errored", "disconnected", "degraded", "partial"]), is_locked: z.boolean(),
  metadata: z.object({ v1_account_id: ProviderIdentifier.optional(),
    products_connection_status: z.record(z.string(), z.enum(["running", "disconnected", "errored"])).optional() }),
});
const Senders = z.object({data: z.array(z.object({object: z.literal("EmailSender"), email: z.email(),
  is_primary: z.boolean(), verification_status: z.enum(["verified", "pending", "unknown"])})),
  next_cursor: z.string().optional(), total_count: z.number().int().nonnegative().optional()});
const Profile = z.object({object: z.literal("UserProfile"), provider: z.literal("linkedin"),
  id: ProviderIdentifier, type: z.literal("individual"), display_name: z.string().max(400),
  profile_url: z.string().optional(), public_identifier: z.string().optional(),
  specifics: z.object({network_distance: z.literal("SELF")})});

/** V2 never falls back to V1 credentials or accepts account.name as mailbox evidence. */
export function createUnipileV2Provider(settings: UnipileV2Settings & {fetchImpl?: typeof fetch; timeoutMs?: number}) {
  if (!settings.accessToken.trim() || !ProviderIdentifier.safeParse(settings.applicationId).success) throw new Error("Invalid Unipile V2 configuration.");
  const origins = settings.hostedAuthOrigins.map(origin => parseHostedAuthOrigin(origin));
  if (!origins.length || origins.includes("https://account.unipile.com")) throw new Error("Invalid Unipile V2 hosted origin.");
  const fetchImpl = settings.fetchImpl ?? fetch;
  const timeoutMs = settings.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Invalid Unipile V2 timeout.");
  function fail(code = "UNIPILE_UNAVAILABLE", status = 502): never {
    throw new PublicError({code, status, message: "LIFTY could not verify this connection. Check status and reconnect if needed."});
  }
  async function request(path: string, body?: Record<string, unknown>, method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET"): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.unipile.com/v2/${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: {"X-API-KEY": settings.accessToken, accept: "application/json", ...(body ? {"content-type": "application/json"} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (path === "auth/link") fail(`UNIPILE_HOSTED_HTTP_${response.status}`);
        if (response.status === 404) fail("UNIPILE_ACCOUNT_NOT_FOUND", 409);
        fail();
      }
      if (!response.body) fail();
      const chunks: Uint8Array[] = []; let size = 0;
      await response.body.pipeTo(new WritableStream<Uint8Array>({write(chunk) {
        size += chunk.byteLength; if (size > 1_048_576) fail(); chunks.push(chunk);
      }}), {signal: controller.signal});
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof PublicError) throw error;
      fail(path === "auth/link" ? "UNIPILE_HOSTED_TRANSPORT_FAILED" : "UNIPILE_UNAVAILABLE");
    } finally {clearTimeout(timer);}
  }
  function validateTransport(transport: UnipileTransport) {
    if (transport.api_version !== "v2" || transport.application_id !== settings.applicationId
      || !origins.includes(transport.hosted_auth_origin)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
  }
  async function readAccount(accountId: string, transport: UnipileTransport, channel: "email" | "linkedin") {
    validateTransport(transport);
    if (!ProviderIdentifier.safeParse(accountId).success || (transport.account_id && accountId !== transport.account_id)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const result = Account.safeParse(await request(`accounts/${encodeURIComponent(accountId)}`));
    if (!result.success) fail();
    const account = result.data;
    if (account.id !== accountId || account.application_id !== transport.application_id
      || (account.account_scope_id ?? null) !== transport.account_scope_id
      || (channel !== "linkedin" && transport.user_id && account.user_id !== transport.user_id)
      || (transport.v1_account_id && account.metadata.v1_account_id !== transport.v1_account_id)
      || (transport.canonical_account_id && transport.provider_namespace !== `unipile:v2:${transport.application_id}`
        && account.metadata.v1_account_id !== transport.canonical_account_id)
      || ((channel === "linkedin") !== (account.provider === "linkedin"))) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const verifiedTransport: VerifiedTransport = {api_version: "v2", account_id: account.id,
      application_id: account.application_id, account_scope_id: account.account_scope_id ?? null,
      user_id: account.user_id, owner_profile_id: null, v1_account_id: account.metadata.v1_account_id ?? null};
    const products = account.metadata.products_connection_status;
    const healthy = !account.is_locked && account.status === "running"
      && (!products || Object.values(products).every(status => status === "running"));
    const healthStatus: LinkedinIdentity["healthStatus"] = account.is_locked ? "locked" : healthy ? "running"
      : account.status === "disconnected" ? "disconnected" : account.status === "errored" || account.status === "degraded" ? "errored" : "unknown";
    return {account, verifiedTransport, healthy, healthStatus};
  }
  async function createLink(input: {channel: "email" | "linkedin"; state: string; redirectUri: string; expiresAt: string; transport: UnipileTransport}) {
    validateTransport(input.transport);
    const origin = input.transport.hosted_auth_origin;
    const raw = await request("auth/link", {
      ...(input.transport.account_id ? {account_id: input.transport.account_id} : {providers: input.channel === "linkedin" ? ["linkedin"] : ["google"]}),
      ...(input.transport.account_scope_id ? {account_scope_id: input.transport.account_scope_id} : {}),
      ...(origin !== "https://auth.unipile.com" ? {domain: new URL(origin).hostname} : {}),
      expires_on: input.expiresAt, redirect_uri: input.redirectUri, state: input.state,
    });
    const parsed = z.object({object: z.literal("HostedAuthLink"), link: z.url()}).safeParse(raw);
    if (!parsed.success) fail("UNIPILE_HOSTED_RESPONSE_INVALID");
    const link = new URL(parsed.data.link);
    if (link.origin !== origin || link.username || link.password || link.hash || link.port) fail("UNIPILE_HOSTED_URL_INVALID");
    return link.toString();
  }
  async function readEmailIdentity(accountId: string, transport: UnipileTransport, expectedEmail?: string | null) {
    const {account, verifiedTransport, healthy} = await readAccount(accountId, transport, "email");
    // V2 does not expose V1's IMAP/SMTP identity evidence or delegated Outlook
    // mailbox flag. Keep those providers on V1 until equivalent proof is documented.
    if (account.provider !== "google") fail("UNIPILE_MAILBOX_UNVERIFIABLE", 409);
    // An unhealthy provider may reject profile calls. A previously verified
    // mailbox can still be reported unhealthy without inventing fresh proof.
    if (!healthy && expectedEmail) return {accountId:transport.canonical_account_id ?? accountId,
      email:expectedEmail.toLowerCase(),type:"GOOGLE_OAUTH" as const,healthy:false,verifiedTransport};
    const parsed = Senders.safeParse(await request(`${encodeURIComponent(accountId)}/email-senders`));
    if (!parsed.success || parsed.data.next_cursor || (parsed.data.total_count !== undefined && parsed.data.total_count !== parsed.data.data.length)) fail();
    const primaries = parsed.data.data.filter(sender => sender.is_primary);
    if (primaries.length !== 1 || primaries[0]!.verification_status !== "verified") fail("UNIPILE_MAILBOX_UNVERIFIABLE", 409);
    const email = primaries[0]!.email.toLowerCase();
    if (expectedEmail && expectedEmail.toLowerCase() !== email) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    return {accountId: transport.canonical_account_id ?? accountId, email, type: "GOOGLE_OAUTH" as const, healthy, verifiedTransport};
  }
  async function readLinkedinIdentity(accountId: string, transport: UnipileTransport, expectedProfileId?: string | null) {
    const {account, verifiedTransport, healthy, healthStatus} = await readAccount(accountId, transport, "linkedin");
    const retainedOwner = transport.owner_profile_id;
    if ((transport.canonical_account_id && !retainedOwner)
      || (retainedOwner && expectedProfileId && retainedOwner !== expectedProfileId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const canonical = transport.canonical_account_id ?? accountId;
    // A disconnected connection can retain its established owner, but an
    // unverified new connection must never infer ownership from Account.user_id.
    if (!healthy) {
      if (!retainedOwner) fail();
      if (account.user_id === transport.user_id) return {accountId: canonical, profileId: retainedOwner, profileUrl: null, displayName: null, healthy, healthStatus, verifiedTransport};
    }
    // Copied Account.user_id may contain mutable display metadata. Report its
    // current value, but only authenticated SELF proves the LinkedIn owner.
    // Even unhealthy accounts must provide SELF if that metadata has changed.
    const parsed = Profile.safeParse(await request(`${encodeURIComponent(accountId)}/users/me`));
    if (!parsed.success) fail();
    if ((retainedOwner && parsed.data.id !== retainedOwner)
      || (expectedProfileId && parsed.data.id !== expectedProfileId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    verifiedTransport.owner_profile_id = parsed.data.id;
    let profileUrl: string | null = null;
    try {
      const url = new URL(parsed.data.profile_url ?? `https://www.linkedin.com/in/${parsed.data.public_identifier ?? ""}/`);
      if (url.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.hash && !url.search && /^\/in\/[A-Za-z0-9_%~-]+\/?$/.test(url.pathname)) profileUrl = url.toString();
    } catch { /* Optional display metadata. */ }
    return {accountId: canonical, profileId: parsed.data.id, profileUrl, displayName: parsed.data.display_name || null, healthy, healthStatus, verifiedTransport};
  }
  const AccountList = z.object({object: z.literal("Accounts"), data: z.array(z.object({id: ProviderIdentifier, provider: z.string(),
    status: z.string(), is_locked: z.boolean(), metadata: z.object({v1_account_id: ProviderIdentifier.optional()}).passthrough().optional()}).passthrough()),
    has_more: z.boolean().optional()}).passthrough();
  /** Accounts of one provider visible to this application. Read-only; identity still needs an authenticated SELF read. */
  async function listAccounts(provider: "linkedin" | "google"): Promise<{id: string; v1AccountId: string | null; healthy: boolean}[]> {
    const found: {id: string; v1AccountId: string | null; healthy: boolean}[] = [];
    for (let page = 0, offset = 0; page < 5; page++, offset += 100) {
      const parsed = AccountList.safeParse(await request(`accounts/?provider=${provider}&limit=100&offset=${offset}`));
      if (!parsed.success) fail();
      for (const item of parsed.data.data) found.push({id: item.id, v1AccountId: item.metadata?.v1_account_id ?? null, healthy: !item.is_locked && item.status === "running"});
      if (!parsed.data.has_more) break;
    }
    return found;
  }
  /** Authenticated SELF profile identifier of a LinkedIn account; the only owner evidence V2 accepts. */
  async function readOwnerProfileId(accountId: string): Promise<string> {
    const parsed = Profile.safeParse(await request(`${encodeURIComponent(ProviderIdentifier.parse(accountId))}/users/me`));
    if (!parsed.success) fail();
    return parsed.data.id;
  }
  /** Verified primary sender of a Google account, or null when none is verified. */
  async function readPrimarySenderEmail(accountId: string): Promise<string | null> {
    const parsed = Senders.safeParse(await request(`${encodeURIComponent(ProviderIdentifier.parse(accountId))}/email-senders`));
    if (!parsed.success) fail();
    const primary = parsed.data.data.find(sender => sender.is_primary && sender.verification_status === "verified");
    return primary ? primary.email.toLowerCase() : null;
  }
  /** Removes a V2 account that this attempt created or that is a verified unreferenced duplicate. */
  async function deleteAccount(accountId: string): Promise<void> {
    if (!/^acc_[A-Za-z0-9_-]{1,251}$/.test(accountId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    await request(`accounts/${encodeURIComponent(accountId)}`, undefined, "DELETE");
  }
  return {createLink, readEmailIdentity, readLinkedinIdentity, listAccounts, readOwnerProfileId, readPrimarySenderEmail, deleteAccount};
}
