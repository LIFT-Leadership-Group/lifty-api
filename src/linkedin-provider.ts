import { z } from "zod";
import { PublicError } from "./errors.js";
import type { UnipileProviderSettings } from "./unipile-provider.js";

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const Account = z.object({
  object: z.literal("Account"), id: Identifier, type: z.literal("LINKEDIN"),
  connection_params: z.object({ im: z.object({ id: Identifier, publicIdentifier: z.string().optional() }) }),
  sources: z.array(z.object({ id: z.string(), status: z.string() })),
});
// These are selected fields of the documented v1 AccountOwnerProfile. Other
// provider fields are deliberately dropped, including email and credentials.
const Owner = z.object({
  object: z.literal("AccountOwnerProfile"), provider: z.literal("LINKEDIN"), provider_id: Identifier,
  public_identifier: z.string().optional(), public_profile_url: z.string().optional(),
  first_name: z.string().max(200), last_name: z.string().max(200),
});
export type LinkedinHealth = "running" | "credentials" | "locked" | "disconnected" | "errored" | "unknown";
export interface LinkedinIdentity {
  accountId: string;
  profileId: string;
  profileUrl: string | null;
  displayName: string | null;
  healthy: boolean;
  healthStatus: LinkedinHealth;
}
function failure(suffix = "UNAVAILABLE", status = 502) {
  return new PublicError({ status, code: `UNIPILE_LINKEDIN_${suffix}`, message: "LIFTY could not verify the LinkedIn connection. Check status and reconnect from the CLI if needed." });
}
function profileUrl(owner: z.infer<typeof Owner>): string | null {
  if (owner.public_profile_url) {
    try {
      const url = new URL(owner.public_profile_url);
      if (url.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.search && !url.hash
        && /^\/in\/[^/]+\/?$/.test(url.pathname)) return url.toString();
    } catch { /* Display metadata is optional; never trust a provider URL as a handoff. */ }
  }
  return owner.public_identifier && /^[A-Za-z0-9_-]{1,255}$/.test(owner.public_identifier)
    ? `https://www.linkedin.com/in/${owner.public_identifier}/` : null;
}

/** Control-plane HTTP only: hosted authentication and authenticated readback. */
export function createLinkedinProvider(settings: UnipileProviderSettings) {
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
        if (hosted) throw failure(`HOSTED_HTTP_${response.status}`);
        if (response.status === 404) throw failure("ACCOUNT_NOT_FOUND", 409);
        if (response.status === 401 || response.status === 403) throw failure("ACCOUNT_UNHEALTHY", 409);
        throw failure();
      }
      if (!response.body) throw failure();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      await response.body.pipeTo(new WritableStream<Uint8Array>({ write(chunk) {
        bytes += chunk.byteLength;
        if (bytes > 1_048_576) throw failure();
        chunks.push(chunk);
      } }), { signal: controller.signal });
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw failure(hosted ? "HOSTED_RESPONSE_INVALID" : "UNAVAILABLE"); }
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw failure(hosted ? "HOSTED_TRANSPORT_FAILED" : "UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }
  async function createLink(input: { correlation: string; notifyUrl: string; expiresAt: string; reconnectId: string | null }): Promise<string> {
    const raw = await request("hosted/accounts/link", {
      type: input.reconnectId ? "reconnect" : "create",
      ...(input.reconnectId ? { reconnect_account: Identifier.parse(input.reconnectId) } : { providers: ["LINKEDIN"] }),
      api_url: base.origin, expiresOn: input.expiresAt, name: input.correlation,
      notify_url: input.notifyUrl, single_use: true,
    });
    const parsed = z.object({ object: z.enum(["HostedAuthUrl", "HostedAuthURL"]), url: z.url() }).safeParse(raw);
    if (!parsed.success) throw failure("HOSTED_RESPONSE_INVALID");
    const url = new URL(parsed.data.url);
    if (url.protocol !== "https:" || url.hostname !== "account.unipile.com" || url.port
      || url.username || url.password || url.hash) throw failure("HOSTED_URL_INVALID");
    return url.toString();
  }
  async function readIdentity(accountId: string, expectedProfileId?: string | null): Promise<LinkedinIdentity> {
    if (!Identifier.safeParse(accountId).success) throw failure("IDENTITY_MISMATCH", 409);
    const parsed = Account.safeParse(await request(`accounts/${encodeURIComponent(accountId)}`));
    if (!parsed.success || parsed.data.id !== accountId) throw failure("IDENTITY_MISMATCH", 409);
    const { connection_params: { im }, sources } = parsed.data;
    if (expectedProfileId && im.id !== expectedProfileId) throw failure("IDENTITY_MISMATCH", 409);
    const validSources = sources.length > 0 && sources.every(source => source.id.trim().length > 0)
      && new Set(sources.map(source => source.id)).size === sources.length;
    const healthy = validSources && sources.every(source => source.status === "OK");
    const healthStatus: LinkedinHealth = healthy ? "running" : !validSources ? "unknown" :
      sources.some(source => source.status === "CREDENTIALS") ? "credentials" :
      sources.some(source => source.status === "ERROR") ? "errored" :
      sources.some(source => source.status === "STOPPED") ? "disconnected" : "unknown";
    if (!healthy) return { accountId, profileId: im.id, profileUrl: null, displayName: null, healthy, healthStatus };
    const owner = Owner.safeParse(await request(`users/me?account_id=${encodeURIComponent(accountId)}`));
    if (!owner.success || owner.data.provider_id !== im.id || (expectedProfileId && owner.data.provider_id !== expectedProfileId))
      throw failure("IDENTITY_MISMATCH", 409);
    return { accountId, profileId: owner.data.provider_id, profileUrl: profileUrl(owner.data),
      displayName: `${owner.data.first_name} ${owner.data.last_name}`.trim() || null, healthy, healthStatus };
  }
  return { createLink, readIdentity };
}
