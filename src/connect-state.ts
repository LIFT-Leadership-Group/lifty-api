import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Opaque browser handle for one durable connection attempt. It reveals no id,
// is bound to its channel (a handle opened under the other channel's page
// fails) and is keyed by that channel's existing server key.
export type ConnectChannel = "email" | "linkedin";
const pattern = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = (secret: string) => createHash("sha256").update("lifty:connect:key:v1\0").update(secret).digest();
const aad = (channel: ConnectChannel) => Buffer.from(`lifty:connect:${channel}:v1`);

export function sealConnectAttempt(channel: ConnectChannel, attemptId: string, secret: string): string {
  if (!uuid.test(attemptId)) throw new Error("Invalid connection attempt.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce); cipher.setAAD(aad(channel));
  const data = Buffer.concat([cipher.update(Buffer.from(attemptId.replaceAll("-", ""), "hex")), cipher.final()]);
  return ["v1", nonce.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function openConnectAttempt(channel: ConnectChannel, state: string, secret: string): string {
  try {
    if (!pattern.test(state)) throw new Error();
    const [, iv, body, tag] = state.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv!, "base64url"));
    decipher.setAAD(aad(channel)); decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body!, "base64url")), decipher.final()]).toString("hex");
    return `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
  } catch { throw new Error("Invalid connection attempt."); }
}
