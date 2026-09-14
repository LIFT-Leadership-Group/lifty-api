import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { EmailConnectRequest, EmailConnectResult, EmailConnectionStatus, type EmailConnectInput, type EmailStart, type EmailStatus } from "./email-contracts.js";
import { createUnipileProvider, type UnipileProviderSettings } from "./unipile-provider.js";
import { sealEmailIntent, openEmailIntent, emailCallbackName, validEmailCallbackName } from "./email-state.js";

export interface EmailConnectSettings extends UnipileProviderSettings {
  serverKey: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
}
interface RpcClient { rpc(name: string,args: Record<string,unknown>): Promise<{data:unknown;error:unknown}> }
const Stored = z.object({
  state: z.enum(["not_connected","pending","connected","disconnected","failed","revoked"]),
  workspace_ref: z.uuid(), email: z.email().optional(), mailbox_use: z.enum(["personal","outreach"]).optional(),
  daily_limit: z.number().int().min(1).max(10).optional(),
  account_id: z.string().nullable().optional(), connection_ref: z.uuid().nullable().optional(), intent_ref: z.uuid().nullable().optional(),
  expires_at: z.string().optional(), failure_code: z.enum(["identity_mismatch","provider_unavailable","link_failed"]).nullable().optional(),
});
const Intent = z.object({state:z.enum(["pending","issuing","ready","completed","failed"]),intent_ref:z.uuid(),workspace_ref:z.uuid(),email:z.email(),expires_at:z.string(),account_id:z.string().nullable(),hosted_url:z.url().nullable()});
function fail(code: string, status = 409): never {
  const messages: Record<string,string> = {
    EMAIL_WORKSPACE_FORBIDDEN: "Choose a workspace you belong to.",
    EMAIL_PROFILE_CONFLICT: "This workspace already has a different email or mailbox-use declaration. Contact LIFT to change it.",
    EMAIL_INTENT_EXPIRED: "This email connection link expired. Run the connect command again.",
    EMAIL_LINK_PENDING: "An email connection link is being prepared. Try opening it again shortly.",
    EMAIL_IDENTITY_MISMATCH: "Authorize the exact email address you selected in LIFTY.",
  };
  throw new PublicError({status,code,message:messages[code] ?? "LIFTY could not complete the email connection. Try again from the CLI."});
}
function mapRpcError(error: unknown): never {
  const parsed = z.object({code:z.string().optional(),message:z.string().optional()}).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const safe = ["email_workspace_forbidden","email_workspace_suspended","email_profile_conflict","email_intent_expired","email_identity_mismatch","email_account_taken","email_namespace_mismatch"];
  const code = safe.find(value=>message===value);
  fail(code?.toUpperCase() ?? "EMAIL_CONNECTION_UNAVAILABLE", parsed.success && parsed.data.code==="PT403" ? 403 : code ? 409 : 502);
}
export function createEmailConnectOperations(settings: EmailConnectSettings) {
  if(settings.serverKey.length<32) throw new Error("Invalid email server key.");
  const provider = createUnipileProvider(settings);
  const fetchImpl = settings.fetchImpl ?? fetch;
  async function rpc(operation:string,payload:Record<string,unknown>,session?:AuthSession):Promise<unknown> {
    const args={p_server_key:settings.serverKey,p_operation:operation,p_payload:payload};
    if(session){
      const {data,error}=await (session.client as RpcClient).rpc("lifty_email_connection",args);
      if(error)mapRpcError(error); return data;
    }
    try {
      const response=await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/lifty_email_connection`,{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{apikey:settings.publishableKey,"content-type":"application/json"},body:JSON.stringify(args),
      });
      const data:unknown=await response.json();
      if(!response.ok)mapRpcError(data); return data;
    }catch(error){if(error instanceof PublicError)throw error; fail("EMAIL_CONNECTION_UNAVAILABLE",502);}
  }
  const publicProfile=(value:z.infer<typeof Stored>)=>({provider:"unipile" as const,channel:"email" as const,workspace_ref:value.workspace_ref,email:value.email,
    mailbox_use:value.mailbox_use,daily_limit:value.daily_limit,warmup_required:value.mailbox_use==="outreach",sending_enabled:false as const});
  async function status(session:AuthSession,workspace:string):Promise<EmailStatus>{
    const value=Stored.parse(await rpc("status",{workspace},session));
    if(!value.email || value.state==="not_connected")return EmailConnectionStatus.parse({provider:"unipile",channel:"email",workspace_ref:value.workspace_ref,status:"not_connected"});
    let state=value.state;
    if(state==="connected" && value.account_id){
      try {if(!(await provider.readIdentity(value.account_id,value.email)).healthy)state="disconnected";}
      catch(error){if(error instanceof PublicError && ["UNIPILE_ACCOUNT_NOT_FOUND","UNIPILE_IDENTITY_MISMATCH"].includes(error.code))state="disconnected";else throw error;}
    }
    return EmailConnectionStatus.parse({...publicProfile(value),status:state==="revoked"?"disconnected":state,
      connection_ref:value.connection_ref??null,intent_ref:value.intent_ref??null,failure_code:value.failure_code??null});
  }
  async function start(session:AuthSession,input:EmailConnectInput):Promise<EmailStart>{
    const parsed=EmailConnectRequest.parse(input);
    let value=Stored.parse(await rpc("start",parsed,session));
    if(value.state==="connected" && value.account_id){
      const identity=await provider.readIdentity(value.account_id,parsed.email);
      if(identity.healthy)return EmailConnectResult.parse({...publicProfile(value),status:"connected",connection_ref:value.connection_ref});
      await rpc("disconnect",{workspace:parsed.workspace},session);
      value=Stored.parse(await rpc("start",parsed,session));
    }
    if(!value.intent_ref || !value.expires_at)fail("EMAIL_CONNECTION_UNAVAILABLE",502);
    const seconds=Math.min(1800,Math.floor((Date.parse(value.expires_at)-Date.now())/1000));
    if(!Number.isFinite(seconds)||seconds<=0)fail("EMAIL_INTENT_EXPIRED");
    const state=sealEmailIntent(value.intent_ref,settings.serverKey);
    return EmailConnectResult.parse({...publicProfile(value),status:"pending",intent_ref:value.intent_ref,
      connect_url:`${settings.publicBaseUrl}/unipile/start?intent=${encodeURIComponent(state)}`,expires_in_seconds:seconds});
  }
  function open(state:string):string {try{return openEmailIntent(state,settings.serverKey);}catch{fail("EMAIL_INTENT_EXPIRED",410);}}
  async function authorize(state:string):Promise<string>{
    const id=open(state);
    const intent=Intent.parse(await rpc("intent",{intent_ref:id}));
    if(intent.state==="ready" && intent.hosted_url)return intent.hosted_url;
    const claim=z.object({claimed:z.boolean()}).parse(await rpc("issue_link",{intent_ref:id}));
    if(!claim.claimed)fail("EMAIL_LINK_PENDING");
    try {
      const url=await provider.createLink({correlation:emailCallbackName(id,settings.serverKey),
        notifyUrl:`${settings.publicBaseUrl}/unipile/callback?intent=${encodeURIComponent(state)}`,
        expiresAt:new Date(intent.expires_at).toISOString(),reconnectId:intent.account_id});
      await rpc("save_link",{intent_ref:id,url}); return url;
    }catch{
      await rpc("fail",{intent_ref:id,failure_code:"link_failed"});fail("EMAIL_CONNECTION_UNAVAILABLE",502);
    }
  }
  async function callback(state:string,body:unknown):Promise<void>{
    const id=open(state);
    const parsed=z.object({status:z.enum(["CREATION_SUCCESS","RECONNECTED"]),account_id:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),name:z.string()}).safeParse(body);
    if(!parsed.success || !validEmailCallbackName(id,parsed.data.name,settings.serverKey))fail("EMAIL_CALLBACK_INVALID",403);
    const intent=Intent.parse(await rpc("intent",{intent_ref:id}));
    if(!["ready","completed"].includes(intent.state))fail("EMAIL_INTENT_EXPIRED",410);
    if(intent.account_id && intent.account_id!==parsed.data.account_id)fail("EMAIL_IDENTITY_MISMATCH");
    let identity;
    try{identity=await provider.readIdentity(parsed.data.account_id,intent.email);}catch(error){
      if(error instanceof PublicError && error.code==="UNIPILE_IDENTITY_MISMATCH")await rpc("fail",{intent_ref:id,failure_code:"identity_mismatch"});
      throw error;
    }
    if(!identity.healthy)fail("EMAIL_PROVIDER_NOT_READY",503);
    await rpc("complete",{intent_ref:id,account_id:identity.accountId,email:identity.email});
  }
  return {start,status,authorize,callback};
}
