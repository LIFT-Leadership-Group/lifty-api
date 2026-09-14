import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const aad = Buffer.from("lifty:email-connect:v1");
const pattern = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const key = (secret: string) => createHash("sha256").update("lifty:email-connect:key:v1\0").update(secret).digest();
export function sealEmailIntent(id: string, secret: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid email intent.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",key(secret),nonce); cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(Buffer.from(id.replaceAll("-",""),"hex")),cipher.final()]);
  return ["v1",nonce.toString("base64url"),data.toString("base64url"),cipher.getAuthTag().toString("base64url")].join(".");
}
export function openEmailIntent(state: string, secret: string): string {
  try {
    if (!pattern.test(state)) throw new Error();
    const [,iv,body,tag] = state.split(".");
    const decipher = createDecipheriv("aes-256-gcm",key(secret),Buffer.from(iv!,"base64url"));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(tag!,"base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body!,"base64url")),decipher.final()]).toString("hex");
    return `${plain.slice(0,8)}-${plain.slice(8,12)}-${plain.slice(12,16)}-${plain.slice(16,20)}-${plain.slice(20)}`;
  } catch { throw new Error("Invalid email intent."); }
}
export function emailCallbackName(id: string, secret: string): string {
  return createHmac("sha256",secret).update(`lifty:email-notify:v1:${id}`).digest("hex");
}
export function validEmailCallbackName(id: string, name: string, secret: string): boolean {
  return /^[0-9a-f]{64}$/.test(name) && timingSafeEqual(Buffer.from(name,"hex"),Buffer.from(emailCallbackName(id,secret),"hex"));
}
