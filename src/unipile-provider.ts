import { z } from "zod";
import { PublicError } from "./errors.js";

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
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw failure();
    } finally { clearTimeout(timer); }
  }

  async function createLink(input: { correlation: string; notifyUrl: string; expiresAt: string; reconnectId: string | null }): Promise<string> {
    const raw = await request("hosted/accounts/link", {
      type: input.reconnectId ? "reconnect" : "create",
      ...(input.reconnectId ? { reconnect_account: AccountId.parse(input.reconnectId) } : { providers: "*:MAILING" }),
      api_url: base.origin, expiresOn: input.expiresAt, name: input.correlation,
      notify_url: input.notifyUrl, single_use: true,
      sync_limit: { MAILING: "NO_HISTORY_SYNC" }, disabled_options: ["sync_limit"],
    });
    const parsed = z.object({ object: z.literal("HostedAuthURL"), url: z.string().url() }).safeParse(raw);
    if (!parsed.success) throw failure();
    const url = new URL(parsed.data.url);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port
      || url.username || url.password || url.hash) throw failure();
    return url.toString();
  }

  async function readIdentity(accountId: string, expectedEmail: string) {
    if (!AccountId.safeParse(accountId).success) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    const parsed = Account.safeParse(await request(`accounts/${encodeURIComponent(accountId)}`));
    if (!parsed.success || parsed.data.id !== accountId) throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    const { type, connection_params: { mail }, sources } = parsed.data;
    const matches = (value: string | undefined) => value?.toLowerCase() === expectedEmail;
    if (type === "MAIL" ? !matches(mail.imap_user) || !matches(mail.smtp_user) : !matches(mail.username) || !mail.id) {
      throw failure("UNIPILE_IDENTITY_MISMATCH", 409);
    }
    const healthy = type === "MAIL" ? sources.every(source => source.status === "OK")
      : sources.filter(source => source.id === mail.id).length === 1 && sources.find(source => source.id === mail.id)?.status === "OK";
    return { accountId, email: expectedEmail, type, healthy };
  }

  return { createLink, readIdentity };
}
