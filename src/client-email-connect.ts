import { connectionFetch } from "./connection-confirmation.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import type { EmailConnectSettings } from "./email-connect.js";
import { createEmailAccountOperations } from "./email-accounts.js";
import { EmailAccountConnectRequest, EmailAccountConnectResult, EmailAccountStatusRequest, EmailAccountStatusResult,
  type EmailAccountConnectInput, type EmailAccountStatusInput } from "./email-accounts-contracts.js";
import { createUnipileProvider } from "./unipile-provider.js";
import { createUnipileV2Provider } from "./unipile-v2-provider.js";
import { UnipileTransport } from "./unipile-transport.js";
import { PublicError } from "./errors.js";
import { HostedReturnError, hostedReturnReason } from "./hosted-return-error.js";
import type { ConnectionReturnResult } from "./connection-return-page.js";

const Claims=z.object({v:z.literal(2),workspace_id:z.uuid(),workspace_slug:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),sender_id:z.uuid(),
  channel:z.literal("email"),identity:z.email(),iat:z.number().int().nonnegative(),exp:z.number().int(),nonce:z.uuid(),issuer_user_id:z.uuid()}).strict();
const Snapshot=z.object({intent_ref:z.uuid().nullable(),workspace_ref:z.uuid(),workspace_slug:z.string(),sender_ref:z.uuid(),
  issuer_user_id:z.uuid().nullable(),email:z.email(),state:z.enum(["pending","issuing","ready","completed","failed","connecting","connected","disconnected","revoked"]),
  expires_at:z.string().nullable(),connection_ref:z.uuid().nullable(),account_id:z.string().nullable(),transport:UnipileTransport,
  hosted_url:z.url().nullable(),authorization_received:z.boolean(),authorization_account_id:z.string().nullable(),
  return_error:HostedReturnError.nullable(),campaign_send_paused:z.boolean().nullable(),
  connection_status:z.enum(["connecting","connected","disconnected","revoked"]).nullable()});
type Snapshot=z.infer<typeof Snapshot>;
type Claims=z.infer<typeof Claims>;
interface RpcClient {rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>}
const errors:Record<string,{status:number;code:string;message:string}>={
  client_update_required:{status:409,code:"CLIENT_UPDATE_REQUIRED",message:"Update Lifty and request a fresh link. New accounts use the Lifty-branded connection flow."},
  new_accounts_require_v2:{status:503,code:"EMAIL_V2_UNAVAILABLE",message:"Lifty's connection service is not ready for new accounts. Try again later."},
  client_email_workspace_forbidden:{status:403,code:"EMAIL_WORKSPACE_FORBIDDEN",message:"Choose a workspace you belong to."},
  client_email_sender_unavailable:{status:409,code:"EMAIL_SENDER_UNAVAILABLE",message:"Choose an active sender from this workspace."},
  client_email_intent_expired:{status:410,code:"EMAIL_INTENT_EXPIRED",message:"This sign-in link expired. Request a fresh link, or check the saved connection if you already signed in."},
  client_email_account_taken:{status:409,code:"EMAIL_ACCOUNT_TAKEN",message:"This mailbox is already linked elsewhere. Keep the existing connection and resolve its ownership before retrying."},
  client_email_identity_mismatch:{status:409,code:"EMAIL_IDENTITY_MISMATCH",message:"Sign in with the exact mailbox you selected in Lifty."},
};
function fail(name="unavailable"):never {
  throw new PublicError(errors[name] ?? {status:502,code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:"Lifty could not verify this connection. Check its status before requesting another link."});
}
function rpcError(error:unknown):never {
  const parsed=z.object({message:z.string().optional(),code:z.string().optional()}).safeParse(error);
  const message=parsed.success ? parsed.data.message ?? "" : "";
  if(errors[message])fail(message);
  const alias:Record<string,string>={email_workspace_forbidden:"client_email_workspace_forbidden",email_sender_unavailable:"client_email_sender_unavailable",
    email_attempt_expired:"client_email_intent_expired",email_authorization_mismatch:"client_email_identity_mismatch",outreach_account_taken:"client_email_account_taken",
    email_provider_unavailable:"new_accounts_require_v2"};
  if(alias[message])fail(alias[message]);
  if(parsed.success && parsed.data.code==="PT403")fail("client_email_workspace_forbidden");
  if(parsed.success && parsed.data.code==="PT410")fail("client_email_intent_expired");
  fail();
}
function sameWorkspace(input:string,row:Snapshot){return input===row.workspace_slug || input.toLowerCase()===row.workspace_ref;}

/** Client attempts belong to existing senders, never the founder's singleton profile. */
export function createClientEmailOperations(settings:EmailConnectSettings) {
  if(settings.serverKey.length<32)throw Error("Invalid client email server key");
  const legacy=createEmailAccountOperations(settings),v1=createUnipileProvider(settings);
  const v2=settings.v2 ? createUnipileV2Provider({...settings.v2,...(settings.fetchImpl ? {fetchImpl:settings.fetchImpl} : {})}) : null;
  const fetchImpl=connectionFetch(settings.fetchImpl ?? fetch);
  async function rpc(operation:string,payload:Record<string,unknown>,session?:AuthSession):Promise<unknown>{
    const args={p_server_key:settings.serverKey,p_operation:operation,p_payload:payload};
    if(session){const {data,error}=await (session.client as RpcClient).rpc("lifty_client_email_connection",args);if(error)rpcError(error);return data;}
    try {
      const response=await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/lifty_client_email_connection`,{method:"POST",redirect:"error",
        signal:AbortSignal.timeout(15000),headers:{apikey:settings.publishableKey,"content-type":"application/json"},body:JSON.stringify(args)});
      const body:unknown=await response.json();if(!response.ok)rpcError(body);return body;
    } catch(error){if(error instanceof PublicError)throw error;fail();}
  }
  const mac=(body:string)=>createHmac("sha256",settings.serverKey).update(`lifty.client-email.v2.${body}`).digest();
  function seal(row:Snapshot,userId:string):string {
    if(!row.intent_ref || !row.expires_at || row.issuer_user_id!==userId)fail();
    const exp=Math.floor(Date.parse(row.expires_at)/1000);
    const claims=Claims.parse({v:2,workspace_id:row.workspace_ref,workspace_slug:row.workspace_slug,sender_id:row.sender_ref,
      channel:"email",identity:row.email,iat:exp-3600,exp,nonce:row.intent_ref,issuer_user_id:userId});
    const body=Buffer.from(JSON.stringify(claims)).toString("base64url");return `${body}.${mac(body).toString("base64url")}`;
  }
  function open(token:string):Claims {
    try {
      if(token.length>4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw Error();
      const [body,signature]=token.split(".") as [string,string], bytes=Buffer.from(body,"base64url"), supplied=Buffer.from(signature,"base64url");
      if(bytes.toString("base64url")!==body || supplied.toString("base64url")!==signature || !timingSafeEqual(mac(body),supplied))throw Error();
      const claims=Claims.parse(JSON.parse(bytes.toString("utf8")));
      if(claims.exp!==claims.iat+3600 || claims.identity!==claims.identity.toLowerCase())throw Error();return claims;
    }catch{fail("client_email_intent_expired");}
  }
  function correlate(row:Snapshot,claims:Claims) {
    if(row.intent_ref!==claims.nonce || row.workspace_ref!==claims.workspace_id || row.workspace_slug!==claims.workspace_slug
      || row.sender_ref!==claims.sender_id || row.email!==claims.identity || row.issuer_user_id!==claims.issuer_user_id
      || !row.expires_at || Math.floor(Date.parse(row.expires_at)/1000)!==claims.exp)fail();
  }
  async function intent(token:string) {
    const claims=open(token),row=Snapshot.parse(await rpc("intent",{intent_ref:claims.nonce}));correlate(row,claims);return row;
  }
  function requireV2(row:Snapshot) {
    if(!v2 || row.transport.api_version!=="v2" || row.transport.application_id!==settings.v2?.applicationId)fail("new_accounts_require_v2");
    return v2;
  }
  async function identity(row:Snapshot,accountId:string) {
    return row.transport.api_version==="v2" ? requireV2(row).readEmailIdentity(accountId,row.transport,row.email) : v1.readIdentity(accountId,row.email);
  }
  async function complete(row:Snapshot):Promise<boolean> {
    if(!row.intent_ref || !row.authorization_received || !row.authorization_account_id)return false;
    const verified=await identity(row,row.authorization_account_id);
    if(!verified.healthy)return false;
    if(!("verifiedTransport" in verified))fail();
    await rpc("complete",{intent_ref:row.intent_ref,account_id:verified.accountId,email:verified.email,verified_transport:verified.verifiedTransport});return true;
  }
  async function connect(session:AuthSession,input:EmailAccountConnectInput){
    const parsed=EmailAccountConnectRequest.parse(input);
    // Version negotiation happens before native attempt creation in the DB.
    const raw=await rpc("start",{workspace:parsed.workspace,sender_ref:parsed.sender_ref,email:parsed.email,allow_v2:parsed.protocol_version===2},session);
    if(z.object({legacy:z.literal(true)}).safeParse(raw).success)return legacy.connect(session,parsed);
    const row=Snapshot.parse(raw);
    if(!sameWorkspace(parsed.workspace,row) || row.sender_ref!==parsed.sender_ref || row.email!==parsed.email)fail();
    requireV2(row);
    const token=seal(row,session.userId);
    return EmailAccountConnectResult.parse({provider:"unipile",channel:"email",workspace_ref:row.workspace_ref,sender_ref:row.sender_ref,email:row.email,
      status:"link_issued",connection_url:`${settings.publicBaseUrl}/unipile/client-email/start?intent=${token}`,
      attempt_ref:token,expires_at:new Date(open(token).exp*1000).toISOString()});
  }
  async function authorize(token:string):Promise<string>{
    const row=await intent(token);
    if(row.state==="completed" || row.authorization_received)return "authorization_received";
    requireV2(row);
    if(row.state==="ready" && row.hosted_url)return row.hosted_url;
    if(row.state==="failed" || !row.expires_at || Date.parse(row.expires_at)<=Date.now())fail("client_email_intent_expired");
    const claim=z.object({claimed:z.boolean()}).parse(await rpc("issue_link",{intent_ref:row.intent_ref}));
    if(!claim.claimed)throw new PublicError({status:409,code:"EMAIL_LINK_PENDING",message:"Your link is being prepared. Try opening it again shortly."});
    try {
      const prefix=`lifty.v2.client-email.${row.intent_ref}`;
      const state=`${prefix}.${createHmac("sha256",settings.serverKey).update(prefix).digest("hex")}`;
      await rpc("auth_state",{intent_ref:row.intent_ref,state});
      const url=await requireV2(row).createLink({channel:"email",state,transport:row.transport,expiresAt:row.expires_at,
        redirectUri:`${settings.publicBaseUrl}/unipile/v2/client-email/return?intent=${token}`});
      await rpc("save_link",{intent_ref:row.intent_ref,url});return url;
    }catch(error){await rpc("fail",{intent_ref:row.intent_ref,failure_code:"link_failed"});throw error;}
  }
  async function status(session:AuthSession,input:EmailAccountStatusInput){
    const parsed=EmailAccountStatusRequest.parse(input);
    let claims:Claims|undefined;
    if("attempt_ref" in parsed){
      // Legacy tokens are validated by their original issuer. A native token
      // never falls through to the V1 endpoint when its signature is invalid.
      let version:unknown;try{version=JSON.parse(Buffer.from(parsed.attempt_ref.split(".")[0]!,"base64url").toString()).v;}catch{fail("client_email_intent_expired");}
      if(version===1)return legacy.status(session,parsed);
      claims=open(parsed.attempt_ref);if(claims.issuer_user_id!==session.userId)fail("client_email_workspace_forbidden");
    }
    const request={workspace:parsed.workspace,...(claims ? {attempt_ref:claims.nonce} : {connection_ref:(parsed as {connection_ref:string}).connection_ref})};
    let row=Snapshot.parse(await rpc("status",request,session));
    const verify=()=>{if(!sameWorkspace(parsed.workspace,row) || ("connection_ref" in parsed && row.connection_ref!==parsed.connection_ref))fail();if(claims)correlate(row,claims);};verify();
    if(!row.connection_ref && row.authorization_received){
      await complete(row);row=Snapshot.parse(await rpc("status",request,session));verify();
    }
    let healthy=false;
    if(row.connection_ref && row.account_id){
      let verified:Awaited<ReturnType<ReturnType<typeof createUnipileV2Provider>["readEmailIdentity"]>>|undefined;
      try {
        if(row.transport.api_version==="v2"){
          verified=await requireV2(row).readEmailIdentity(row.transport.account_id ?? row.account_id,row.transport,row.email);
          healthy=verified.healthy;
        }else healthy=(await identity(row,row.account_id)).healthy;
      }
      catch(error){if(!(error instanceof PublicError) || !["UNIPILE_ACCOUNT_NOT_FOUND","UNIPILE_IDENTITY_MISMATCH"].includes(error.code))throw error;}
      const verifiedAt=new Date().toISOString();
      // A provider call is not authority to disclose a connection after its
      // member was revoked or its route changed while that call was in flight.
      const fresh=Snapshot.parse(await rpc("status",request,session));
      if(fresh.connection_ref!==row.connection_ref || fresh.email!==row.email || fresh.account_id!==row.account_id
        || JSON.stringify(fresh.transport)!==JSON.stringify(row.transport))fail();row=fresh;verify();
      if(row.transport.api_version==="v2" && verified){
        const reconciled=Snapshot.parse(await rpc("health",{workspace:parsed.workspace,connection_ref:row.connection_ref,
          email:verified.email,status:verified.healthStatus,observed_at:verifiedAt,
          verified_transport:verified.verifiedTransport,transport_generation:row.transport.generation},session));
        if(reconciled.connection_ref!==row.connection_ref || reconciled.email!==row.email || reconciled.account_id!==row.account_id
          || JSON.stringify(reconciled.transport)!==JSON.stringify(row.transport))fail();row=reconciled;verify();
      }
      if(row.connection_status!=="connected")healthy=false;
    }
    return EmailAccountStatusResult.parse({provider:"unipile",channel:"email",workspace_ref:row.workspace_ref,sender_ref:row.sender_ref,email:row.email,
      status:row.connection_ref ? (healthy ? "connected" : "needs_reconnect") : row.state==="failed" ? "conflict" : row.return_error ? "needs_authorization" : "pending",
      connection_ref:row.connection_ref,campaign_send_paused:row.campaign_send_paused});
  }
  async function v2Return(token:string,returnError:HostedReturnError|null=null):Promise<ConnectionReturnResult>{
    const row=await intent(token);requireV2(row);
    if(row.state==="completed")return row.connection_status==="connected" ? {status:"connected",account:row.email} : {status:"failed",reason:"verification"};
    if(returnError && !row.authorization_received){await rpc("return_error",{intent_ref:row.intent_ref,return_error:returnError});return {status:"failed",reason:hostedReturnReason[returnError]};}
    if(row.state==="failed")return {status:"failed",reason:"ended"};
    try{return await complete(row) ? {status:"connected",account:row.email} : {status:"pending"};}
    catch(error){if(error instanceof PublicError && ["UNIPILE_IDENTITY_MISMATCH","UNIPILE_MAILBOX_UNVERIFIABLE","EMAIL_ACCOUNT_TAKEN"].includes(error.code))return {status:"failed",reason:"verification"};throw error;}
  }
  return {accounts:legacy.accounts,connect,status,authorize,v2Return,validateReturn:(state:string)=>{open(state);}};
}
