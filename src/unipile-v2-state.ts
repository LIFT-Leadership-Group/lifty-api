import { createHmac } from "node:crypto";

/** Stable across duplicate browser visits; authority still requires a signed provider event. */
export function unipileV2AuthState(channel: "email" | "linkedin", intentRef: string, serverKey: string): string {
  const prefix = `lifty.v2.${channel}.${intentRef}`;
  return `${prefix}.${createHmac("sha256", serverKey).update(prefix).digest("hex")}`;
}
