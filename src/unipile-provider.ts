import { z } from "zod";
import { PublicError } from "./errors.js";

const OwnerProfile = z.object({object:z.literal("AccountOwnerProfile"),provider:z.literal("GMAIL"),email:z.email(),
  aliases:z.array(z.object({email:z.email(),is_primary:z.boolean().optional()}))});
const AccountId = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const Account = z.object({
  id: AccountId,
  type: z.enum(["GOOGLE_OAUTH", "OUTLOOK", "MAIL"]),
  connection_params: z.object({ mail: z.object({
    id: z.string().optional(), username: z.string().optional(),
    imap_user: z.string().optional(), smtp_user: z.string().optional(),
  }) }),
  sources: z.array(z.object({ id: z.string(), status: z.string() })).min(1),
});

export interface UnipileProviderSettings {
  dsn: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function failure(code = "UNIPILE_UNAVAILABLE", status = 502): PublicError {
  return new PublicError({ status, code, message: "LIFTY could not verify the email connection. Try again from the CLI." });
}

/** Control-plane HTTP only. Never sends email, retries a POST, or returns provider bodies. */
export function createUnipileProvider(settings: UnipileProviderSettings) {
  const base = new URL(settings.dsn);
  if (base.protocol !== "https:" || !/^[a-z0-9-]+\.unipile\.com$/.test(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || !settings.accessToken.trim()) throw new Error("Invalid Unipile configuration.");
  const timeoutMs = settings.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Invalid Unipile timeout.");
  const fetchImpl = settings.fetchImpl ?? fetch;

  async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const hosted = path === "hosted/accounts/link";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(`/api/v1/${path}`, base), {
        method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { "X-API-KEY": settings.accessToken, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (hosted) throw failure(`UNIPILE_HOSTED_HTTP_${response.status}`);
        if (response.status === 404) throw failure("UNIPILE_ACCOUNT_NOT_FOUND", 409);
        throw failure();
      }
      if (!response.body) throw failure();
      // pipeTo aborts even if a response implementation ignores the fetch signal.
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      await response.body.pipeTo(new WritableStream<Uint8Array>({
        write(chunk) {
          bytes += chunk.byteLength;
          if (bytes > 1_048_576) throw failure();
          chunks.push(chunk);
        },
      }), { signal: controller.signal });
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw failure(hosted ? "UNIPILE_HOSTED_RESPONSE_INVALID" : "UNIPILE_UNAVAILABLE"); }
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw failure(hosted ? "UNIPILE_HOSTED_TRANSPORT_FAILED" : "UNIPILE_UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }

  async function createLink(input: { correlation: string; notifyUrl: string; expiresAt: string; reconnectId: string | null }): Promise<string> {
    const raw = await request("hosted/accounts/link", {
      type: input.reconnectId ? "reconnect" : "create",
      ...(input.reconnectId ? { reconnect_account: AccountId.parse(input.reconnectId) } : { providers: ["GOOGLE"] }),
      api_url: base.origin, expiresOn: input.expiresAt, name: input.correlation,
      notify_url: input.notifyUrl, single_use: true,
      sync_limit: { MAILING: "NO_HISTORY_SYNC" }, disabled_options: ["sync_limit"],
    });
    // Current OpenAPI/SDK use HostedAuthUrl; the hosted-auth guide still shows
    // HostedAuthURL. Accept only these two documented discriminators.
    const parsed = z.object({ object: z.enum(["HostedAuthUrl", "HostedAuthURL"]), url: z.string().url() }).safeParse(raw);
    if (!parsed.success) throw failure("UNIPILE_HOSTED_RESPONSE_INVALID");
    const url = new URL(parsed.data.url);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port
      || url.username || url.password || url.hash) throw failure("UNIPILE_HOSTED_URL_INVALID");
    return url.toString();
  }

  async function readIdentity(accountId: string, expectedEmail: string) {
    if (!AccountId.safeParse(accountId).success) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    const parsed = Account.safeParse(await request(`accounts/${encodeURIComponent(accountId)}`));
    if (!parsed.success || parsed.data.id !== accountId) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    const { type, connection_params: { mail }, sources } = parsed.data;
    const matches = (value: string | undefined) => value?.toLowerCase() === expectedEmail;
    // The v1 beta accepts Gmail, including Google Workspace. Provider readback,
    // never the email domain, also gates old links, reconnections and recovery.
    if (type !== "GOOGLE_OAUTH") {
      throw new PublicError({status:409,code:"UNIPILE_MAILBOX_UNVERIFIABLE",
        message:"LIFTY’s email beta supports Gmail only, including Google Workspace. Connect with Google OAuth; Outlook and IMAP/SMTP accounts are not supported."});
    }
    if (!matches(mail.username) || !mail.id) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    // Source IDs are independent of connection_params.mail.id. Until Unipile
    // exposes a typed mail-source association, require every source to be healthy.
    const healthy = sources.every(source => source.id.trim().length > 0 && source.status === "OK")
      && new Set(sources.map(source => source.id)).size === sources.length;
    if (healthy) {
      // Account usernames can be aliases. The authenticated own-profile endpoint
      // supplies current primary evidence; it does not establish a stable Google sub.
      const owner = OwnerProfile.safeParse(await request(`users/me?account_id=${encodeURIComponent(accountId)}`));
      if (!owner.success || !matches(owner.data.email)) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
      const primary = owner.data.aliases.filter(alias => alias.is_primary === true);
      if (primary.length !== 1 || !matches(primary[0]?.email)) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    }
    return { accountId, email: expectedEmail, type, healthy };
  }

  return { createLink, readIdentity };
}
