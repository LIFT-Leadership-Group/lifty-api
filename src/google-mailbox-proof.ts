import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const Context = z.object({
  grantRef:z.uuid(), intentRef:z.uuid(), workspaceRef:z.uuid(),
  nonce:z.string().min(32).max(512), expectedEmail:z.email().max(254),
}).strict();
/** This context comes from a persisted server claim, never the OAuth callback's query/body. */
export type GoogleGrantContext = z.infer<typeof Context>;
declare const verifiedGoogleGrant: unique symbol;
/** Opaque type: only this verifier constructs it. It is identity/access-token
 * proof, NOT proof that Unipile imported or refreshed the same grant. */
export interface VerifiedGoogleMailboxGrant {
  readonly [verifiedGoogleGrant]: true;
  readonly issuer:"https://accounts.google.com";
  readonly subject:string;
  readonly email:string;
  readonly clientId:string;
  readonly grantRef:string;
  readonly workspaceRef:string;
  readonly intentRef:string;
  readonly nonceSha256:string;
  readonly accessTokenSha256:string;
  readonly idTokenSha256:string;
}
const sha256 = (value:string) => createHash("sha256").update(value,"utf8").digest("hex");
const same = (left:string,right:string) => {
  const a=Buffer.from(left,"utf8"), b=Buffer.from(right,"utf8");
  return a.length===b.length && timingSafeEqual(a,b);
};

/** Pure with an injected key set; the production default reads only Google's
 * fixed HTTPS JWKS endpoint. No tokeninfo calls, logging, OAuth exchange or import.
 * Contracts: developers.google.com/identity/openid-connect/openid-connect and
 * /reference. Only RS256 server-flow tokens with at_hash are supported. */
export function createGoogleMailboxProofVerifier(settings: {
  clientId:string;
  keySet?:JWTVerifyGetKey;
  now?:()=>Date;
}) {
  if(!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(settings.clientId)
    || settings.clientId.length>255) throw new Error("Invalid Google client configuration.");
  const keySet=settings.keySet ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"),{
    timeoutDuration:5_000, cooldownDuration:30_000, cacheMaxAge:600_000,
  });
  return async function verifyGoogleMailboxGrant(
    tokens:{idToken:string;accessToken:string}, input:GoogleGrantContext,
  ):Promise<VerifiedGoogleMailboxGrant> {
    try {
      const context=Context.parse(input);
      if(typeof tokens.idToken!=="string" || tokens.idToken.length>32_768 || !tokens.idToken
        || typeof tokens.accessToken!=="string" || tokens.accessToken.length>16_384 || !tokens.accessToken) throw new Error();
      const now=settings.now?.() ?? new Date();
      const {payload}=await jwtVerify(tokens.idToken,keySet,{
        algorithms:["RS256"], issuer:["https://accounts.google.com","accounts.google.com"],
        audience:settings.clientId, currentDate:now, clockTolerance:0,
        requiredClaims:["iss","aud","sub","exp","iat","nonce","at_hash","email","email_verified"],
      });
      if(payload.aud!==settings.clientId || (payload.azp!==undefined && payload.azp!==settings.clientId)
        || typeof payload.iat!=="number" || !Number.isInteger(payload.iat)
        || payload.iat>Math.floor(now.getTime()/1000)+30
        || typeof payload.sub!=="string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)
        || typeof payload.nonce!=="string" || !same(payload.nonce,context.nonce)
        || typeof payload.at_hash!=="string" || payload.email_verified!==true
        || typeof payload.email!=="string" || !z.email().safeParse(payload.email).success) throw new Error();
      const expectedHash=createHash("sha256").update(tokens.accessToken,"utf8").digest().subarray(0,16).toString("base64url");
      if(!same(payload.at_hash,expectedHash)) throw new Error();
      const email=payload.email.toLowerCase();
      if(email!==context.expectedEmail.toLowerCase()) throw new Error();
      const domain=email.slice(email.lastIndexOf("@")+1);
      // For a non-Gmail address, a verified Workspace hosted-domain claim is
      // required. Email/domain are a current-mailbox check, never principal keys.
      if(domain!=="gmail.com" && (typeof payload.hd!=="string" || !payload.hd.trim()
        || payload.hd.length>253 || /[\s/@]/.test(payload.hd))) throw new Error();
      return Object.freeze({
        issuer:"https://accounts.google.com",subject:payload.sub,email,clientId:settings.clientId,
        grantRef:context.grantRef,workspaceRef:context.workspaceRef,intentRef:context.intentRef,
        nonceSha256:sha256(context.nonce),accessTokenSha256:sha256(tokens.accessToken),idTokenSha256:sha256(tokens.idToken),
      }) as VerifiedGoogleMailboxGrant;
    } catch {
      // No upstream error/cause: JOSE diagnostics may contain JWT claims.
      throw new Error("Google mailbox identity could not be verified.");
    }
  };
}
