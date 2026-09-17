import { isIP } from "node:net";

export const UNIPILE_HOSTED_AUTH_ORIGIN = "https://account.unipile.com";

/** Deployment-owned origin, enabled only after Unipile confirms DNS/TLS setup. */
export function parseHostedAuthOrigin(value?: string): string {
  try {
    const url = new URL(value?.trim() || UNIPILE_HOSTED_AUTH_ORIGIN);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash || isIP(url.hostname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("UNIPILE_HOSTED_AUTH_ORIGIN must be an HTTPS DNS origin without credentials, port, path, query or fragment.");
  }
}

/** Stored/provider URLs stay canonical. Rewrite only at the browser boundary. */
export function brandedHostedAuthUrl(target: string, origin: string): string | null {
  try {
    const url = new URL(target);
    if (url.origin !== UNIPILE_HOSTED_AUTH_ORIGIN || url.username || url.password || url.hash) return null;
    url.hostname = new URL(origin).hostname;
    return url.toString();
  } catch { return null; }
}
