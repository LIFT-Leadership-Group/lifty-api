import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const AAD = Buffer.from("lifty:hubspot-connect-state:v1", "utf8");
const SEALED_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/;

function keyFromSecret(secret: string): Buffer {
  if (!secret) throw new Error("invalid_hubspot_state");
  return createHash("sha256")
    .update("lifty:hubspot-connect-state:key:v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

export function isSealedHubspotState(value: string): boolean {
  return SEALED_PATTERN.test(value);
}

export function sealHubspotConnectIntent(
  intentToken: string,
  secret: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(intentToken)) {
    throw new Error("invalid_hubspot_state");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(intentToken, "hex")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function openHubspotConnectIntent(
  state: string,
  secret: string,
): string {
  try {
    if (!isSealedHubspotState(state)) throw new Error("invalid");
    const parts = state.split(".");
    const nonceValue = parts[1]!;
    const ciphertextValue = parts[2]!;
    const tagValue = parts[3]!;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFromSecret(secret),
      Buffer.from(nonceValue, "base64url"),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.length !== 32) throw new Error("invalid");
    return plaintext.toString("hex");
  } catch {
    throw new Error("invalid_hubspot_state");
  }
}
