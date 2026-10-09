import { z } from "zod";
import type { AccountProviderSettings } from "./account-provider.js";
import { connectionFetch } from "./connection-confirmation.js";
import { PublicError } from "./errors.js";
import { UnipileTransport } from "./unipile-transport.js";
import { createUnipileV2Provider } from "./unipile-v2-provider.js";

const Account = z.object({
  object: z.literal("Account"), id: z.string().min(1), type: z.string().min(1),
  connection_params: z.object({ mail: z.object({
    id: z.string().optional(), username: z.string().optional(), mailbox_id: z.string().optional(),
  }) }).optional(),
  sources: z.array(z.object({ id: z.string(), status: z.string() })).optional(),
});
const Owner = z.discriminatedUnion("provider", [
  z.object({ object: z.literal("AccountOwnerProfile"), provider: z.literal("GMAIL"), email: z.email(),
    aliases: z.array(z.object({ email: z.email(), is_primary: z.boolean().optional() })) }),
  z.object({ object: z.literal("AccountOwnerProfile"), provider: z.literal("OUTLOOK"),
    id: z.string().min(1), email: z.email() }),
]);
const lostStatuses = new Set(["CREDENTIALS", "ERROR", "STOPPED", "PERMISSIONS"]);
function connectionRequired(): never {
  throw new PublicError({ status: 409, code: "WARMUP_CONNECTION_REQUIRED",
    message: "Lifty could not verify this mailbox. Check the email connection before setting up warmup." });
}
function verificationPending(): never {
  throw new PublicError({ status: 503, code: "WARMUP_VERIFICATION_PENDING",
    message: "Lifty could not check this mailbox yet. Try the warmup setup link again shortly." });
}

/** Selects a provider from authenticated mailbox evidence, never its domain.
 * V1 follows Jobs' Unipile email-client primary/health policy. Its credential
 * namespace is a stable organization scope, not a DSN (which can rotate).
 * Provider contracts: accountscontroller_getaccountbyid and
 * userscontroller_getaccountownerprofile on developer.unipile.com/reference. */
export function createWarmupMailboxIdentifier(settings: AccountProviderSettings) {
  const v2 = createUnipileV2Provider({ ...settings.v2,
    ...(settings.fetchImpl ? { fetchImpl: settings.fetchImpl } : {}),
    ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
  });
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const timeoutMs = settings.timeoutMs ?? 15_000;
  const v1 = settings.v1;
  const base = v1 ? new URL(v1.dsn) : null;
  if (base && (base.protocol !== "https:" || !/^[a-z0-9-]+\.unipile\.com$/.test(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || !v1!.accessToken.trim())) throw new Error("Invalid Unipile V1 configuration.");

  async function readV1(path: string, signal: AbortSignal): Promise<unknown> {
    if (!base || !v1) verificationPending();
    const response = await fetchImpl(new URL(`/api/v1/${path}`, base), {
      method: "GET", redirect: "error", signal,
      headers: { "X-API-KEY": v1.accessToken, accept: "application/json" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // This is an existing, database-pinned account, not a pending UniLogin.
      if (response.status === 404) connectionRequired();
      verificationPending();
    }
    if (!response.body) verificationPending();
    const chunks: Uint8Array[] = []; let size = 0;
    await response.body.pipeTo(new WritableStream<Uint8Array>({ write(chunk) {
      size += chunk.byteLength;
      if (size > 1_048_576) verificationPending();
      chunks.push(chunk);
    } }), { signal });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  }

  return async (value: UnipileTransport, email: string): Promise<"google" | "microsoft"> => {
    const parsed = UnipileTransport.safeParse(value);
    if (!parsed.success || !z.email().safeParse(email).success) connectionRequired();
    const transport = parsed.data, expected = email.toLowerCase();
    if (!transport.account_id || !transport.canonical_account_id) connectionRequired();
    try {
      if (transport.api_version === "v2") {
        const identity = await v2.readEmailIdentity(transport.account_id, transport, expected);
        if (!identity.healthy || identity.email !== expected) connectionRequired();
        return identity.type === "OUTLOOK" ? "microsoft" : "google";
      }
      if (!base || !v1?.providerNamespace?.trim()) verificationPending();
      if (transport.provider_namespace !== v1.providerNamespace
        || transport.account_id !== transport.canonical_account_id
        || transport.application_id !== null || transport.account_scope_id !== null
        || transport.user_id !== null || transport.v1_account_id !== null
        || transport.owner_profile_id !== null) connectionRequired();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const raw = Account.safeParse(await readV1(`accounts/${encodeURIComponent(transport.account_id)}`, controller.signal));
        if (!raw.success) verificationPending();
        const account = raw.data;
        if (account.id !== transport.account_id || !["GOOGLE_OAUTH", "OUTLOOK"].includes(account.type)) connectionRequired();
        const mail = account.connection_params?.mail;
        if (!mail?.id || !z.email().safeParse(mail.username).success) verificationPending();
        if (mail.username!.toLowerCase() !== expected
          || (account.type === "OUTLOOK" && mail.mailbox_id)) connectionRequired();
        const sources = account.sources;
        if (!sources?.length || sources.some(source => !source.id.trim())
          || new Set(sources.map(source => source.id)).size !== sources.length) verificationPending();
        if (sources.some(source => lostStatuses.has(source.status))) connectionRequired();
        if (sources.some(source => source.status !== "OK")) verificationPending();
        const ownResponse = await readV1(`users/me?account_id=${encodeURIComponent(transport.account_id)}`, controller.signal);
        const kind = z.object({ object: z.literal("AccountOwnerProfile"), provider: z.string() }).safeParse(ownResponse);
        if (!kind.success) verificationPending();
        if (kind.data.provider !== (account.type === "GOOGLE_OAUTH" ? "GMAIL" : "OUTLOOK")) connectionRequired();
        const own = Owner.safeParse(ownResponse);
        if (!own.success) verificationPending();
        if (own.data.email.toLowerCase() !== expected) connectionRequired();
        if (own.data.provider === "GMAIL") {
          const primary = own.data.aliases.filter(alias => alias.is_primary === true);
          if (primary.length !== 1 || primary[0]!.email.toLowerCase() !== expected) connectionRequired();
        }
        return account.type === "OUTLOOK" ? "microsoft" : "google";
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error instanceof PublicError) {
        if (["WARMUP_CONNECTION_REQUIRED", "WARMUP_VERIFICATION_PENDING"].includes(error.code)) throw error;
        if (["UNIPILE_IDENTITY_MISMATCH", "UNIPILE_ACCOUNT_NOT_FOUND", "UNIPILE_MAILBOX_UNVERIFIABLE"].includes(error.code)) connectionRequired();
      }
      verificationPending();
    }
  };
}
