import { z } from "zod";
import { UnipileTransport } from "./unipile-transport.js";
import { createUnipileV2Provider } from "./unipile-v2-provider.js";
import { unipileV2AuthState } from "./unipile-v2-state.js";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { HostedEmailProvider, EmailPolicy, EmailConnectRequest, EmailConnectResult, EmailConnectionStatus, type EmailConnectInput, type EmailStart, type EmailStatus } from "./email-contracts.js";
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
  transport: UnipileTransport.optional(),
  provider_selection_required: z.boolean().optional(), email_provider: HostedEmailProvider.nullish(),
  state: z.enum(["not_connected","pending","connected","disconnected","failed","revoked"]),
  workspace_ref: z.uuid(), email: z.email().nullish(), mailbox_use: z.enum(["personal","outreach"]).nullish(),
  email_policy: EmailPolicy.optional(),
  daily_limit: z.number().int().min(1).max(10).optional(),
  account_id: z.string().nullable().optional(), connection_ref: z.uuid().nullable().optional(), intent_ref: z.uuid().nullable().optional(),
  expires_at: z.string().optional(), failure_code: z.enum(["identity_mismatch","provider_unavailable","link_failed","account_taken"]).nullable().optional(),
});
const Intent = z.object({provider_selection_required:z.boolean().optional(),email_provider:HostedEmailProvider.nullish(),transport:UnipileTransport.optional(),authorization_account_id:z.string().nullish(),state:z.enum(["pending","issuing","ready","completed","failed"]),intent_ref:z.uuid(),workspace_ref:z.uuid(),email:z.email().nullable(),expires_at:z.string(),account_id:z.string().nullable(),hosted_url:z.url().nullable(),selection_required:z.boolean().optional(),authorization_received:z.boolean().optional()});
function fail(code: string, status = 409): never {
  const messages: Record<string,string> = {
    EMAIL_WORKSPACE_FORBIDDEN: "Choose a workspace you belong to.",
    EMAIL_PROFILE_CONFLICT: "This mailbox already has a declared use. To change how you use it, disconnect this workspace’s email and connect again.",
    EMAIL_INTENT_EXPIRED: "This email connection link expired. Run the connect command again.",
    EMAIL_LINK_PENDING: "An email connection link is being prepared. Try opening it again shortly.",
    EMAIL_ACCOUNT_TAKEN: "This email is linked to another workspace. Another authorization link will not fix that. Resolve the existing workspace connection before trying again.",
    EMAIL_PROVIDER_REQUIRED: "Choose your email provider before continuing.",
    EMAIL_PROVIDER_CONFLICT: "This link already has an email provider or mailbox use chosen. Continue with the original choices, or disconnect and connect again in Lifty to change them.",
    EMAIL_PROVIDER_INVALID: "Choose one of the email providers shown in Lifty.",
    EMAIL_RESELECTION_REQUIRES_DISCONNECT: "Disconnect this workspace’s saved email before choosing another account or provider.",
    EMAIL_RESELECTION_PENDING_WORK: "This workspace still has email work in progress. Let it finish before choosing another email account.",
    EMAIL_PROVIDER_SELECTION_UNAVAILABLE: "Lifty could not open a new email provider selector. Try again later; the saved account has not been reconnected.",
    EMAIL_IDENTITY_MISMATCH: "Authorize the exact email address you selected in LIFTY.",
    EMAIL_DECLARATION_INVALID: "Choose whether this is a mailbox you already use or a new account for outreach.",
  };
  throw new PublicError({status,code,message:messages[code] ?? "LIFTY could not complete the email connection. Try again from the CLI."});
}
function mapRpcError(error: unknown): never {
  const parsed = z.object({code:z.string().optional(),message:z.string().optional()}).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const safe = ["email_workspace_forbidden","email_workspace_suspended","email_profile_conflict","email_intent_expired","email_identity_mismatch","email_account_taken","email_namespace_mismatch","email_callback_invalid","email_callback_conflict","email_provider_required","email_provider_conflict","email_provider_invalid","email_reselection_requires_disconnect","email_reselection_pending_work","email_provider_selection_unavailable"];
  const code = safe.find(value=>message===value);
  fail(code?.toUpperCase() ?? "EMAIL_CONNECTION_UNAVAILABLE", parsed.success && parsed.data.code==="PT403" ? 403 : parsed.success && parsed.data.code==="PT410" ? 410 : code ? 409 : 502);
}
export function createEmailConnectOperations(settings: EmailConnectSettings) {
  if(settings.serverKey.length<32) throw new Error("Invalid email server key.");
  const provider = createUnipileProvider(settings);
  const v2 = settings.v2 ? createUnipileV2Provider({...settings.v2, ...(settings.fetchImpl ? {fetchImpl: settings.fetchImpl} : {}), ...(settings.timeoutMs ? {timeoutMs:settings.timeoutMs} : {})}) : null;
  function requireV2() {if (!v2) fail("EMAIL_CONNECTION_UNAVAILABLE",503); return v2;}
  function identityProvider(type: "GOOGLE_OAUTH" | "OUTLOOK" | "MAIL"): HostedEmailProvider {
    return type === "GOOGLE_OAUTH" ? "google" : type === "OUTLOOK" ? "outlook" : "imap";
  }
  async function readIdentity(accountId:string,email:string|null|undefined,transport?:UnipileTransport,selectedProvider?:HostedEmailProvider|null) {
    const identity = transport?.api_version === "v2"
      ? await requireV2().readEmailIdentity(transport.account_id ?? accountId,transport,email)
      : await provider.readIdentity(accountId,email);
    if (selectedProvider && identityProvider(identity.type) !== selectedProvider) fail("UNIPILE_IDENTITY_MISMATCH");
    return identity;
  }
  async function readIntent(id:string) {
    const intent=Intent.parse(await rpc("intent",{intent_ref:id}));
    if(intent.intent_ref!==id)fail("EMAIL_CALLBACK_INVALID",403);
    return intent;
  }
  async function complete(intentRef:string,identity:Awaited<ReturnType<typeof readIdentity>>,selectedProvider?:HostedEmailProvider|null) {
    await rpc("complete",{intent_ref:intentRef,account_id:identity.accountId,email:identity.email,
      ...(selectedProvider ? {email_provider:identityProvider(identity.type)} : {}),
      ...("verifiedTransport" in identity ? {verified_transport:identity.verifiedTransport} : {})});
  }
  async function recordAccountTaken(intentRef:string) {
    try {await rpc("fail",{intent_ref:intentRef,failure_code:"account_taken"});}
    catch {/* The rejection itself is the durable outcome; status explains it on the next read. */}
  }
  // Binding is refused only after the provider account exists. Record the
  // precise cause so status can explain it. Mailbox accounts are never deleted
  // here: removing a sibling Google account revokes the surviving grant.
  async function bind(intentRef:string,identity:Awaited<ReturnType<typeof readIdentity>>,selectedProvider?:HostedEmailProvider|null) {
    try {await complete(intentRef,identity,selectedProvider);}
    catch(error){
      if(error instanceof PublicError && error.code==="EMAIL_ACCOUNT_TAKEN")await recordAccountTaken(intentRef);
      throw error;
    }
  }
  const ProbeResult=z.object({referenced:z.array(z.string()),mailbox:z.enum(["free","taken","stale"]).nullable()});
  // A mailbox known before the link is looked up at the provider so an existing
  // account is reconnected instead of duplicated, and a mailbox held live by
  // another workspace fails before any link exists. Explicit account selection
  // and reconnects keep their own routes. Lookups are best-effort.
  async function reusableAccount(intentRef:string,intent:z.infer<typeof Intent>):Promise<string|null>{
    if(!intent.email || intent.account_id || intent.transport?.account_id || intent.provider_selection_required || intent.selection_required)return null;
    const wanted=intent.email.toLowerCase();
    let candidates:string[]=[];
    try {
      if(intent.transport?.api_version==="v2") {
        const v2Provider=requireV2();
        for(const account of (await v2Provider.listAccounts("google")).slice(0,20)) {
          try {if(await v2Provider.readPrimarySenderEmail(account.id)===wanted)candidates.push(account.id);}
          catch {/* An unreadable account is never reused. */}
        }
      } else candidates=await provider.findMailboxAccounts(wanted,intent.email_provider==="outlook"?"OUTLOOK":intent.email_provider==="imap"?"MAIL":intent.email_provider==="google"?"GOOGLE":undefined);
    } catch {candidates=[];}
    const probe=ProbeResult.parse(await rpc("probe",{intent_ref:intentRef,email:wanted,...(candidates.length ? {account_ids:candidates.slice(0,50)} : {})}));
    if(probe.mailbox==="taken"){await recordAccountTaken(intentRef);fail("EMAIL_ACCOUNT_TAKEN");}
    const free=candidates.filter(id=>!probe.referenced.includes(id));
    return free.length===1 ? free[0]! : null;
  }
  const fetchImpl = settings.fetchImpl ?? fetch;
  async function rpc(operation:string,payload:Record<string,unknown>,session?:AuthSession,name:"lifty_email_connection"|"lifty_email_callback_hint"="lifty_email_connection"):Promise<unknown> {
    const args={p_server_key:settings.serverKey,p_operation:operation,p_payload:payload};
    if(session){
      const {data,error}=await (session.client as RpcClient).rpc(name,args);
      if(error)mapRpcError(error); return data;
    }
    try {
      const response=await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/${name}`,{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{apikey:settings.publishableKey,"content-type":"application/json"},body:JSON.stringify(args),
      });
      const data:unknown=await response.json();
      if(!response.ok)mapRpcError(data); return data;
    }catch(error){if(error instanceof PublicError)throw error; fail("EMAIL_CONNECTION_UNAVAILABLE",502);}
  }
  const publicProfile=(value:z.infer<typeof Stored>)=>({provider:"unipile" as const,channel:"email" as const,workspace_ref:value.workspace_ref,email:value.email??null,
    mailbox_use:value.mailbox_use??null,daily_limit:value.daily_limit,
    ...(value.email_policy ? {email_policy:value.email_policy} : {}),
    // Outreach (new/dedicated) mailboxes need verified warmup under every policy
    // (LIF-985); regular personal/business mailboxes never do.
    warmup_required:value.mailbox_use==="outreach",sending_enabled:false as const});
  async function status(session:AuthSession,workspace:string,attemptRef?:string):Promise<EmailStatus>{
    return readStatus(session,workspace,attemptRef,true);
  }
  async function readStatus(session:AuthSession,workspace:string,attemptRef:string|undefined,allowChoiceRefresh:boolean):Promise<EmailStatus>{
    let value=Stored.parse(await rpc("status",{workspace},session));
    if(value.state==="pending" && value.intent_ref && (!attemptRef || value.intent_ref===attemptRef)){
      const pendingIntent=value.transport?.api_version==="v2" || value.email_provider || value.provider_selection_required ? await readIntent(value.intent_ref) : null;
      if (pendingIntent) {
        // A chooser can freeze Google between status and this exact intent read.
        // Accept only the unbound, unselected V1 placeholder becoming V2; all
        // authorization/account evidence below comes from the committed intent.
        const unboundChoiceSnapshot = value.provider_selection_required === true && value.email_provider == null
          && !value.account_id && !value.connection_ref && value.transport?.api_version === "v1"
          && !value.transport.account_id && !value.transport.canonical_account_id && !value.transport.connection_ref;
        const committedGoogleChoice = pendingIntent.provider_selection_required === false && pendingIntent.email_provider === "google"
          && pendingIntent.transport?.api_version === "v2" && !pendingIntent.transport.account_id
          && !pendingIntent.transport.canonical_account_id && !pendingIntent.transport.connection_ref;
        if (unboundChoiceSnapshot && committedGoogleChoice && pendingIntent.workspace_ref === value.workspace_ref
          && pendingIntent.state === "completed" && allowChoiceRefresh) {
          // Another poll may have attached the selected account meanwhile. Read
          // caller-authorized current state once, then verify the connected owner
          // normally; never complete from this stale pre-choice snapshot.
          return readStatus(session,workspace,attemptRef,false);
        }
        const selectedDuringPoll = unboundChoiceSnapshot && committedGoogleChoice && !pendingIntent.account_id;
        if (pendingIntent.workspace_ref !== value.workspace_ref
          || (value.transport && pendingIntent.transport?.api_version !== value.transport.api_version && !selectedDuringPoll)) fail("EMAIL_CALLBACK_INVALID",403);
      }
      const hint=pendingIntent?.transport?.api_version==="v2" ? {account_id:pendingIntent.authorization_received ? pendingIntent.authorization_account_id ?? null : null}
        : z.object({workspace_ref:z.literal(value.workspace_ref),intent_ref:z.literal(value.intent_ref),account_id:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).nullable()})
          .parse(await rpc("read",{workspace_ref:value.workspace_ref,intent_ref:value.intent_ref},session,"lifty_email_callback_hint"));
      if(hint.account_id){
        try {
          if(pendingIntent?.transport?.account_id && pendingIntent.transport.account_id!==hint.account_id)fail("UNIPILE_IDENTITY_MISMATCH");
          const identity=await readIdentity(hint.account_id,pendingIntent ? pendingIntent.email : value.email,pendingIntent?.transport,pendingIntent?.email_provider);
          if(identity.healthy)await bind(value.intent_ref,identity,pendingIntent?.email_provider);
        }catch(error){
          if(error instanceof PublicError && error.code==="UNIPILE_UNAVAILABLE")throw error;
          if(error instanceof PublicError && ["UNIPILE_IDENTITY_MISMATCH","UNIPILE_MAILBOX_UNVERIFIABLE"].includes(error.code))
            await rpc("fail",{intent_ref:value.intent_ref,failure_code:"identity_mismatch"});
          else if(!(error instanceof PublicError && ["UNIPILE_UNAVAILABLE","UNIPILE_ACCOUNT_NOT_FOUND"].includes(error.code)))throw error;
        }
        // Fresh caller-authorized state also observes concurrent disconnect/revocation.
        value=Stored.parse(await rpc("status",{workspace},session));
      }
    }
    if(value.state==="not_connected")return EmailConnectionStatus.parse({provider:"unipile",channel:"email",workspace_ref:value.workspace_ref,status:"not_connected"});
    let state=value.state;
    if(state==="connected" && value.account_id){
      try {if(!(await readIdentity(value.account_id,value.email,value.transport)).healthy)state="disconnected";}
      catch(error){if(error instanceof PublicError && ["UNIPILE_ACCOUNT_NOT_FOUND","UNIPILE_IDENTITY_MISMATCH"].includes(error.code))state="disconnected";else throw error;}
    }
    return EmailConnectionStatus.parse({...publicProfile(value),status:state==="revoked"?"disconnected":state,
      connection_ref:value.connection_ref??null,intent_ref:value.intent_ref??null,failure_code:value.failure_code??null});
  }
  async function start(session:AuthSession,input:EmailConnectInput):Promise<EmailStart>{
    const parsed=EmailConnectRequest.parse(input);
    let value=Stored.parse(await rpc("start",parsed,session));
    // An explicit choose-again request must never silently become the retained
    // account's reconnect, including when an older database ignores the flag.
    if(parsed.select_account && (value.state!=="pending" || value.provider_selection_required!==true
      || value.email || value.account_id || value.connection_ref || value.transport?.account_id
      || value.transport?.canonical_account_id || value.transport?.connection_ref)) fail("EMAIL_PROVIDER_SELECTION_UNAVAILABLE");
    if(value.state==="connected" && value.account_id){
      const identity=await readIdentity(value.account_id,parsed.email,value.transport);
      if(identity.healthy)return EmailConnectResult.parse({...publicProfile(value),status:"connected",connection_ref:value.connection_ref});
      await rpc("disconnect",{workspace:parsed.workspace},session);
      value=Stored.parse(await rpc("start",parsed,session));
    }
    if(!value.intent_ref || !value.expires_at)fail("EMAIL_CONNECTION_UNAVAILABLE",502);
    const seconds=Math.min(1800,Math.floor((Date.parse(value.expires_at)-Date.now())/1000));
    if(!Number.isFinite(seconds)||seconds<=0)fail("EMAIL_INTENT_EXPIRED");
    const state=sealEmailIntent(value.intent_ref,settings.serverKey);
    return EmailConnectResult.parse({...publicProfile(value),status:"pending",intent_ref:value.intent_ref,
      connect_url:`${settings.publicBaseUrl}/unipile/start?intent=${encodeURIComponent(state)}`,expires_in_seconds:seconds,expires_at:value.expires_at});
  }
  function open(state:string):string {try{return openEmailIntent(state,settings.serverKey);}catch{fail("EMAIL_INTENT_EXPIRED",410);}}
  async function authorize(state:string):Promise<string>{
    const id=open(state);
    const intent=await readIntent(id);
    if(intent.state==="completed" || (intent.state==="ready" && intent.authorization_received))return "authorization_received";
    if(intent.provider_selection_required) {
      if (intent.account_id || intent.transport?.canonical_account_id || intent.transport?.connection_ref) fail("EMAIL_PROVIDER_CONFLICT");
      fail("EMAIL_PROVIDER_REQUIRED");
    }
    if(intent.selection_required)throw new PublicError({status:409,code:"EMAIL_DECLARATION_REQUIRED",message:"Say in the hosted connection flow whether this is a mailbox you already use or a new account for outreach."});
    if(intent.state==="ready" && intent.hosted_url)return intent.hosted_url;
    if(intent.state==="failed")fail("EMAIL_INTENT_EXPIRED",410);
    if (intent.email_provider && ((intent.email_provider === "google") !== (intent.transport?.api_version === "v2"))) fail("EMAIL_PROVIDER_CONFLICT");
    const claim=z.object({claimed:z.boolean()}).parse(await rpc("issue_link",{intent_ref:id}));
    if(!claim.claimed)fail("EMAIL_LINK_PENDING");
    let reuse:string|null=null;
    try {reuse=await reusableAccount(id,intent);}
    catch(error){if(error instanceof PublicError && error.code==="EMAIL_ACCOUNT_TAKEN")throw error;}
    let phase:"create"|"save"="create";
    try {
      let url:string;
      if(intent.transport?.api_version==="v2") {
        const authState=unipileV2AuthState("email",id,settings.serverKey);
        await rpc("auth_state",{intent_ref:id,state:authState});
        url=await requireV2().createLink({channel:"email",state:authState,transport:reuse ? {...intent.transport,account_id:reuse} : intent.transport,
          redirectUri:`${settings.publicBaseUrl}/unipile/v2/email/return?intent=${encodeURIComponent(state)}`,
          expiresAt:new Date(intent.expires_at).toISOString()});
      } else url=await provider.createLink({correlation:emailCallbackName(id,settings.serverKey),
        notifyUrl:`${settings.publicBaseUrl}/unipile/callback?intent=${encodeURIComponent(state)}`,
        expiresAt:new Date(intent.expires_at).toISOString(),reconnectId:reuse ?? intent.account_id,
        ...(intent.email_provider ? {provider:intent.email_provider === "outlook" ? "OUTLOOK" as const : "MAIL" as const} : {})});
      phase="save";
      await rpc("save_link",{intent_ref:id,url}); return url;
    }catch(error){
      // Keep the existing SQL failure-code enum; diagnostic codes below are
      // public/API-only and never include provider bodies, URLs or credentials.
      await rpc("fail",{intent_ref:id,failure_code:"link_failed"});
      if(phase==="create" && error instanceof PublicError && /^UNIPILE_HOSTED_(HTTP_[1-5][0-9]{2}|RESPONSE_INVALID|URL_INVALID|TRANSPORT_FAILED)$/.test(error.code))throw error;
      fail(phase==="save"?"EMAIL_LINK_SAVE_FAILED":"EMAIL_LINK_CREATE_FAILED",502);
    }
  }
  async function callback(state:string,body:unknown):Promise<void>{
    const id=open(state);
    const parsed=z.object({status:z.enum(["CREATION_SUCCESS","RECONNECTED"]),account_id:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),name:z.string()}).safeParse(body);
    if(!parsed.success || !validEmailCallbackName(id,parsed.data.name,settings.serverKey))fail("EMAIL_CALLBACK_INVALID",403);
    const intent=await readIntent(id);
    if(intent.transport?.api_version==="v2")fail("EMAIL_CALLBACK_INVALID",403);
    if(!["ready","completed"].includes(intent.state))fail("EMAIL_INTENT_EXPIRED",410);
    if(intent.account_id && intent.account_id!==parsed.data.account_id)fail("EMAIL_IDENTITY_MISMATCH");
    await rpc("record",{workspace_ref:intent.workspace_ref,intent_ref:id,account_id:parsed.data.account_id,callback_name:parsed.data.name},undefined,"lifty_email_callback_hint");
    let identity;
    try{identity=await readIdentity(parsed.data.account_id,intent.email,intent.transport,intent.email_provider);}catch(error){
      if(error instanceof PublicError && ["UNIPILE_IDENTITY_MISMATCH","UNIPILE_MAILBOX_UNVERIFIABLE"].includes(error.code))await rpc("fail",{intent_ref:id,failure_code:"identity_mismatch"});
      throw error;
    }
    if(!identity.healthy)fail("EMAIL_PROVIDER_NOT_READY",503);
    await bind(id,identity,intent.email_provider);
  }
  async function disconnect(session:AuthSession,workspace:string):Promise<EmailStatus> {
    await rpc("disconnect", {workspace}, session);
    return status(session,workspace);
  }
  async function declare(state:string,selectedProvider?:HostedEmailProvider,mailboxUse:"personal"|"outreach"="personal"):Promise<string>{
    const id=open(state);
    if (selectedProvider !== undefined && !HostedEmailProvider.safeParse(selectedProvider).success) fail("EMAIL_PROVIDER_INVALID",400);
    if (mailboxUse !== "personal" && mailboxUse !== "outreach") fail("EMAIL_DECLARATION_INVALID",400);
    await rpc("declare",{intent_ref:id,mailbox_use:mailboxUse,...(selectedProvider ? {email_provider:selectedProvider} : {})});
    return authorize(state);
  }
  async function v2Return(state:string):Promise<void> {
    const intent=await readIntent(open(state));
    if(intent.transport?.api_version!=="v2" || !["ready","completed"].includes(intent.state))fail("EMAIL_CALLBACK_INVALID",403);
    // A browser-supplied account_id is never persisted or treated as authorization.
  }
  return {start,status,authorize,callback,disconnect,declare,v2Return};
}
