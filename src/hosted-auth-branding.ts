import { isIP } from "node:net";

/** Lifty's own hosted sign-in origins (deployment-owned DNS), never the provider's default page. */
export function parseHostedAuthOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash || isIP(url.hostname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Hosted sign-in origins must be HTTPS DNS origins without credentials, port, path, query or fragment.");
  }
}
