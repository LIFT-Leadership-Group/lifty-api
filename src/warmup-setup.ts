import { createHash, createHmac, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import type { MailiverySettings } from "./email-warmup.js";

export const WARMUP_SCHEDULES = ["Weekdays - 8am to 6pm", "Weekdays - 7am to 7pm", "Weekdays - 6am to 10pm",
  "With Weekends - 8am to 6pm", "With Weekends - 7am to 7pm", "With Weekends - 6am to 10pm"] as const;
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", {timeZone: value}); return true; } catch { return false; }
});
export const WarmupPolicy = z.strictObject({version: z.literal(1), emails_per_day: z.number().int().min(1).max(100),
  ramp: z.enum(["slow", "normal", "fast"]), reply_rate: z.number().int().min(0).max(55),
  schedule: z.enum(WARMUP_SCHEDULES), timezone, audience: z.enum(["inherit", "all", "business", "consumer"])});
export type WarmupPolicy = z.infer<typeof WarmupPolicy>;
export const DEFAULT_WARMUP_POLICY: WarmupPolicy = {version:1, emails_per_day:22, ramp:"normal", reply_rate:30,
  schedule:"Weekdays - 8am to 6pm", timezone:"America/New_York", audience:"inherit"};
const name = z.string().trim().max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
// Lifty owns the warmup policy; the founder supplies only the sender name and
// the browser supplies its timezone (an unusable one falls back to the default).
export const WarmupSetupSelection = z.strictObject({first_name:name.pipe(z.string().min(1)), last_name:name,
  timezone:z.string().max(100)});
const SetupRecord = z.object({email:z.email().max(254), workspace_ref:z.uuid(), sender_ref:z.uuid(),
  expires_at:z.iso.datetime({offset:true}), state:z.enum(["draft", "authorizing", "claimed", "dispatched"]),
  policy:WarmupPolicy.nullable(), first_name:name, last_name:name});
export type WarmupSetupRecord = z.infer<typeof SetupRecord>;
export interface WarmupSetupSettings {
  serverKey:string; publicBaseUrl:string; supabaseUrl:string; publishableKey:string;
  googleClientId:string; googleClientSecret:string; mailivery:MailiverySettings;
}
type Rpc = (operation:string, payload:Record<string,unknown>, session?:AuthSession) => Promise<unknown>;
type Identity = {email:string; email_verified:boolean};
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const newSetupSecret = () => randomBytes(32).toString("base64url");
export const hashSetupSecret = (value:string) => createHash("sha256").update(value).digest("hex");
function requireSecret(value:string) { if (!tokenPattern.test(value)) throw invalid(); }
const invalid = () => new PublicError({status:400, code:"WARMUP_SETUP_INVALID", message:"This setup link or request is invalid. Run warmup start to get a new link."});
const unavailable = () => new PublicError({status:409, code:"WARMUP_SETUP_UNAVAILABLE", message:"Setup is expired, already submitted, or the mailbox changed. Check warmup status before getting a new link."});
const pending = () => new PublicError({status:502, code:"WARMUP_HANDOFF_PENDING", message:"The handoff to Mailivery needs checking. Lifty will not resend your tokens or create another warmup. Check warmup status or contact support."});
const googleUnavailable = () => new PublicError({status:502, code:"WARMUP_GOOGLE_UNAVAILABLE", message:"Google authorization could not be verified. No mailbox credentials were sent to Mailivery. Run warmup start to try again."});
const IdentityClaims = z.object({email:z.email().max(254), email_verified:z.literal(true), nonce:z.string()});
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {timeoutDuration:10000});

/** Signature, issuer, audience and nonce are all verified, not just decoded. */
export async function verifyGoogleWarmupIdentity(idToken:string, clientId:string, nonce:string, keys:JWTVerifyGetKey=googleKeys):Promise<Identity> {
  try {
    const {payload} = await jwtVerify(idToken, keys, {issuer:["https://accounts.google.com", "accounts.google.com"], audience:clientId, algorithms:["RS256"], requiredClaims:["exp", "iat", "sub"]});
    const claims = IdentityClaims.parse(payload);
    if (claims.nonce !== nonce || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error();
    return {email:claims.email, email_verified:claims.email_verified};
  } catch { throw googleUnavailable(); }
}

/** Only non-secret intent hashes, policy and a verified email cross the DB boundary.
 * OAuth responses and provider failures are never returned, logged, persisted or retried. */
export function createWarmupSetup(settings:WarmupSetupSettings, dependencies:{rpc?:Rpc;fetchImpl?:typeof fetch;
  verifyIdentity?:(token:string, clientId:string, nonce:string)=>Promise<Identity>}={}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const base = settings.publicBaseUrl.replace(/\/$/, "");
  const redirectUri = `${base}/warmup/google/callback`;
  const mac = (purpose:string, state:string, browser:string) => createHmac("sha256", settings.serverKey)
    .update(`lifty:warmup:v1:${purpose}:${state}:${browser}`).digest("base64url");
  const rpc:Rpc = dependencies.rpc ?? (async (operation, payload, session) => {
    const args = {p_server_key:settings.serverKey, p_operation:operation, p_payload:payload};
    if (session) {
      const result = await (session.client as {rpc(name:string, args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>})
        .rpc("lifty_email_warmup_setup", args);
      if (result.error) throw unavailable();
      return result.data;
    }
    const response = await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/lifty_email_warmup_setup`, {
      method:"POST", redirect:"error", signal:AbortSignal.timeout(15000),
      headers:{apikey:settings.publishableKey, "content-type":"application/json"}, body:JSON.stringify(args),
    });
    if (!response.ok) throw unavailable();
    return response.json();
  });
  async function call(operation:string, payload:Record<string,unknown>, session?:AuthSession):Promise<WarmupSetupRecord> {
    try { return SetupRecord.parse(await rpc(operation, payload, session)); }
    catch { throw unavailable(); }
  }
  const oauthPayload = (state:string, browser:string) => {
    requireSecret(state); requireSecret(browser);
    return {oauth_hash:hashSetupSecret(state), browser_hash:hashSetupSecret(browser)};
  };
  return {
    origin:new URL(base).origin,
    async issue(session:AuthSession, workspace:string) {
      const intent = newSetupSecret();
      const record = await call("issue", {workspace, intent_hash:hashSetupSecret(intent)}, session);
      return {url:`${base}/warmup/setup?intent=${intent}`, expiresAt:record.expires_at};
    },
    async read(intent:string) {
      requireSecret(intent);
      return call("read", {intent_hash:hashSetupSecret(intent)});
    },
    async choose(intent:string, browser:string, input:unknown):Promise<string> {
      requireSecret(intent); requireSecret(browser);
      const parsed = WarmupSetupSelection.safeParse(input);
      if (!parsed.success) throw invalid();
      const {first_name, last_name, timezone:browserZone} = parsed.data;
      const policy = {...DEFAULT_WARMUP_POLICY, ...(timezone.safeParse(browserZone).success ? {timezone:browserZone} : {})};
      const state = newSetupSecret();
      const record = await call("choose", {intent_hash:hashSetupSecret(intent), browser_hash:hashSetupSecret(browser),
        oauth_hash:hashSetupSecret(state), method:"google", first_name, last_name, policy});
      const query = new URLSearchParams({client_id:settings.googleClientId, redirect_uri:redirectUri,
        response_type:"code", scope:"openid email https://mail.google.com/", access_type:"offline", prompt:"consent select_account",
        login_hint:record.email, state, nonce:mac("nonce", state, browser), code_challenge:hashPkce(mac("pkce", state, browser)), code_challenge_method:"S256"});
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async callback(state:string, browser:string, code:string):Promise<void> {
      const payload = oauthPayload(state, browser);
      if (!code || code.length > 4096) throw invalid();
      // Consumed before token exchange; two callbacks can never exchange/deliver twice.
      const record = await call("claim", payload);
      const tokenSchema = z.object({access_token:z.string().min(1).max(16384), refresh_token:z.string().min(1).max(16384),
        id_token:z.string().min(1).max(16384), token_type:z.literal("Bearer"), scope:z.string().max(2048)});
      let tokens:z.infer<typeof tokenSchema>;
      try {
        const response = await fetchImpl("https://oauth2.googleapis.com/token", {method:"POST", redirect:"error", signal:AbortSignal.timeout(15000),
          headers:{"content-type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({code, client_id:settings.googleClientId,
            client_secret:settings.googleClientSecret, redirect_uri:redirectUri, grant_type:"authorization_code", code_verifier:mac("pkce", state, browser)})});
        if (!response.ok) throw new Error();
        tokens = tokenSchema.parse(await response.json());
        if (!tokens.scope.split(/\s+/).includes("https://mail.google.com/")) throw new Error();
      } catch { throw googleUnavailable(); }
      const identity = await (dependencies.verifyIdentity ?? verifyGoogleWarmupIdentity)(tokens.id_token, settings.googleClientId, mac("nonce", state, browser));
      // No Gmail dot/plus/alias equivalence. Stored Unipile emails are canonical lower-case.
      if (!identity.email_verified || identity.email.toLowerCase() !== record.email) throw new PublicError({status:409,
        code:"WARMUP_IDENTITY_MISMATCH", message:`Google did not verify the mailbox connected to Lifty. No tokens were sent to Mailivery. Run warmup start and choose the same address.`});
      if (!record.policy) throw unavailable();
      await call("dispatch", {...payload, verified_email:identity.email.toLowerCase()});
      const body = new FormData();
      const fields = {email:record.email, first_name:record.first_name, last_name:record.last_name,
        email_per_day:String(record.policy.emails_per_day), response_rate:String(record.policy.reply_rate), with_rampup:"true",
        rampup_speed:record.policy.ramp, sending_schedule_presets:record.policy.schedule, timezone:record.policy.timezone,
        warmup_audience_type:record.policy.audience, tags:`lifty-ws:${record.workspace_ref},lifty-sender:${record.sender_ref}`,
        google_token:tokens.access_token, google_refresh_token:tokens.refresh_token};
      for (const [key,value] of Object.entries(fields)) body.set(key,value);
      try {
        const response = await fetchImpl(`${settings.mailivery.baseUrl ?? "https://app.mailivery.io/api/v1"}/campaigns/google-oauth`, {
          method:"POST", redirect:"error", signal:AbortSignal.timeout(15000), headers:{authorization:`Bearer ${settings.mailivery.apiKey}`, accept:"application/json"}, body});
        // Even 2xx is not binding evidence. Jobs verifies email, SMTP, IMAP and both tags.
        // Do not read provider JSON: it can contain mailbox credentials.
        await response.body?.cancel();
        if (!response.ok) throw new Error();
      } catch { throw pending(); }
    },
  };
}
const hashPkce = (value:string) => createHash("sha256").update(value).digest("base64url");
export type WarmupSetup = ReturnType<typeof createWarmupSetup>;
