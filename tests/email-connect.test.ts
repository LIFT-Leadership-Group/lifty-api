import { describe,it,expect } from "vitest";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createUnipileProvider } from "../src/unipile-provider.js";
import { EmailConnectRequest } from "../src/email-contracts.js";
import { sealEmailIntent,openEmailIntent,emailCallbackName } from "../src/email-state.js";
import { createCurrentClient as createApp } from "./current-client.js";

const id="11111111-1111-4111-8111-111111111111", workspace="22222222-2222-4222-8222-222222222222";
const secret="server-key-"+"x".repeat(40), email="founder@example.test";
const state=sealEmailIntent(id,secret);
const settings={dsn:"https://api1.unipile.com:13111",accessToken:"provider-SECRET",serverKey:secret,publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://project.supabase.co",publishableKey:"sb_public"};
const account={id:"account_1",type:"GOOGLE_OAUTH",connection_params:{mail:{id:"mail_1",username:email}},sources:[{id:"source_a",status:"OK"},{id:"source_b",status:"OK"}]};
const owner={object:"AccountOwnerProfile",provider:"GMAIL",email,aliases:[{email,is_primary:true}]};
const imapAccount={...account,type:"MAIL",connection_params:{mail:{
  imap_user:email,imap_host:"imap.example.test",imap_port:993,
  smtp_user:email,smtp_host:"smtp.example.test",smtp_port:465,
}}};
const imapOwner={object:"AccountOwnerProfile",provider:"IMAP",connection_params:{
  imap:{username:email,host:"imap.example.test",port:993},
  smtp:{username:email,host:"smtp.example.test",port:465},
}};
const intent={state:"ready",intent_ref:id,workspace_ref:workspace,email,expires_at:new Date(Date.now()+120000).toISOString(),account_id:null,hosted_url:"https://account.unipile.com/example"};
const body={status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,secret)};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
function harness(options:{identity?:unknown;owner?:unknown;intent?:unknown;status?:number;completeError?:boolean}={}){
  const calls:{operation:string;payload:Record<string,unknown>}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
    if(init?.method==="DELETE")throw new Error("mailbox accounts are never deleted");
    if(String(url).includes("/users/me?")){expect(new URL(String(url)).searchParams.get("account_id")).toBe("account_1");return json(options.owner??owner);}
    if(String(url).includes("/accounts/"))return json(options.identity??account,options.status??200);
    const args=JSON.parse(String(init?.body));
    expect(args.p_server_key).toBe(secret); calls.push({operation:args.p_operation,payload:args.p_payload});
    if(args.p_operation==="complete" && options.completeError)return json({code:"PT409",message:"email_account_taken"},409);
    return json(args.p_operation==="intent"?(options.intent??intent):{ok:true});
  };
  return {ops:createEmailConnectOperations({...settings,fetchImpl}),calls};
}
describe("email hosted auth boundary",()=>{
  it("uses domain-separated, authenticated opaque state",()=>{
    expect(openEmailIntent(state,secret)).toBe(id);
    expect(()=>openEmailIntent(state,secret+"wrong")).toThrow();
    expect(()=>openEmailIntent(state.slice(0,-1)+"!",secret)).toThrow();
    expect(state).not.toContain(id);
  });
  it("rejects a forged callback before reading the provider or database",async()=>{
    const {ops,calls}=harness();
    await expect(ops.callback(state,{...body,name:"0".repeat(64)})).rejects.toMatchObject({code:"EMAIL_CALLBACK_INVALID"});
    expect(calls).toEqual([]);
  });
  it("accepts a Google Workspace custom-domain primary after verifying mailbox and source health",async()=>{
    const {ops,calls}=harness(); await ops.callback(state,body);
    expect(calls.at(-1)).toEqual({operation:"complete",payload:{intent_ref:id,account_id:"account_1",email}});
  });
  it("supports the documented RECONNECTED callback without changing the account pin",async()=>{
    const {ops,calls}=harness({intent:{...intent,account_id:"account_1"}});
    await ops.callback(state,{...body,status:"RECONNECTED"}); expect(calls.at(-1)?.operation).toBe("complete");
    await expect(ops.callback(state,{...body,status:"RECONNECTED",account_id:"other"})).rejects.toMatchObject({code:"EMAIL_IDENTITY_MISMATCH"});
  });
  it("does not trust callback email or account fields over provider readback",async()=>{
    const {ops,calls}=harness({identity:{...account,connection_params:{mail:{id:"mail_1",username:"other@example.test"}}}});
    await expect(ops.callback(state,{...body,email})).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    expect(calls.some(call=>call.operation==="complete")).toBe(false);
    expect(calls.at(-1)?.payload.failure_code).toBe("identity_mismatch");
  });
  it("leaves a temporarily unhealthy provider pending for callback redelivery",async()=>{
    const {ops,calls}=harness({identity:{...account,sources:[{id:"mail_1",status:"CONNECTING"}]}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
    expect(calls.map(c=>c.operation)).toEqual(["intent","record"]);
  });
  it("rejects wrong IDs, SMTP/IMAP ambiguity and unhealthy sources",async()=>{
    for(const identity of [{...account,id:"different"},{...account,type:"MAIL",connection_params:{mail:{smtp_user:email,imap_user:"other@example.test"}}}]){
      const {ops,calls}=harness({identity}); await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
    const {ops}=harness({identity:{...account,sources:[{id:"different",status:"CONNECTING"}]}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
  });
  it("rejects matching IMAP/SMTP usernames without complete service evidence",async()=>{
    const {ops,calls}=harness({identity:{...account,type:"MAIL",connection_params:{mail:{imap_user:email,smtp_user:email}}}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it.each(["CREATION_SUCCESS","RECONNECTED"])("completes IMAP %s with matching authenticated service logins",async(status)=>{
    const {ops,calls}=harness({identity:imapAccount,owner:imapOwner,
      intent:{...intent,email:null,account_id:status==="RECONNECTED"?"account_1":null}});
    await ops.callback(state,{...body,status});
    expect(calls.at(-1)).toEqual({operation:"complete",payload:{intent_ref:id,account_id:"account_1",email}});
  });
  it.each([
    {smtp:{...imapOwner.connection_params.smtp,username:"other@example.test"}},
    {imap:{...imapOwner.connection_params.imap,host:"other.example.test"}},
    {smtp:{...imapOwner.connection_params.smtp,port:587}},
  ])("rejects changed IMAP service evidence before completion: %j",async(changes)=>{
    const {ops,calls}=harness({identity:imapAccount,owner:{...imapOwner,connection_params:{...imapOwner.connection_params,...changes}}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    expect(calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it("keeps unhealthy IMAP authorization pending",async()=>{
    const {ops,calls}=harness({identity:{...imapAccount,sources:[{id:"imap",status:"OK"},{id:"smtp",status:"CREDENTIALS"}]},owner:imapOwner});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
    expect(calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it("requires the exact authenticated primary, not a matching login or default SendAs alias",async()=>{
    for(const [profile,code] of [
      [{...owner,email:"primary@example.test"},"UNIPILE_IDENTITY_MISMATCH"],
      [{...owner,aliases:[]},"UNIPILE_UNAVAILABLE"],
      [{...owner,aliases:[{email,is_default:true}]},"UNIPILE_UNAVAILABLE"],
      [{...owner,aliases:[{email,is_primary:true},{email,is_primary:true}]},"UNIPILE_UNAVAILABLE"],
      [{...owner,aliases:[{email,is_primary:false},{email:"primary@example.test",is_primary:true}]},"UNIPILE_IDENTITY_MISMATCH"],
      [{object:"AccountOwnerProfile",provider:"OUTLOOK",email,id:"other-provider-id"},"UNIPILE_UNAVAILABLE"],
    ] as const) {
      const {ops,calls}=harness({owner:profile});
      await expect(ops.callback(state,body)).rejects.toMatchObject({code});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
      if(code==="UNIPILE_UNAVAILABLE")expect(calls.some(c=>c.operation==="fail")).toBe(false);
    }
  });
  it("does not infer dots, plus tags or custom-domain alias equivalence",async()=>{
    for(const primary of ["founder+alias@example.test","f.ounder@example.test","founder@other.test"]) {
      const {ops,calls}=harness({owner:{...owner,email:primary,aliases:[{email:primary,is_primary:true}]}});
      await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
  });
  it.each(["CREATION_SUCCESS","RECONNECTED"])("completes Outlook %s after verifying the custom-domain owner",async(status)=>{
    const {ops,calls}=harness({identity:{...account,type:"OUTLOOK"},
      owner:{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email},
      intent:{...intent,account_id:status==="RECONNECTED"?"account_1":null}});
    await ops.callback(state,{...body,status});
    expect(calls.at(-1)).toEqual({operation:"complete",payload:{intent_ref:id,account_id:"account_1",email}});
  });
  it.each(["status","start"] as const)("verifies an existing Outlook connection on %s",async(operation)=>{
    const operations:string[]=[],providerPaths:string[]=[];
    const client={rpc:async(_name:string,args:Record<string,unknown>)=>{
      operations.push(String(args.p_operation));
      return {data:{state:"connected",workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:10,
        account_id:"account_1",connection_ref:id,intent_ref:null},error:null};
    }};
    const ops=createEmailConnectOperations({...settings,fetchImpl:async(url)=>{
      providerPaths.push(new URL(String(url)).pathname);
      return json(String(url).includes("/users/me?")
        ? {object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email}
        : {...account,type:"OUTLOOK"});
    }});
    const result=operation==="status"?ops.status({userId:id,client},"senja")
      :ops.start({userId:id,client},{workspace:"senja",email,mailbox_use:"personal"});
    await expect(result).resolves.toMatchObject({status:"connected",email,connection_ref:id});
    expect(operations).toEqual([operation]);
    expect(providerPaths).toEqual(["/api/v1/accounts/account_1","/api/v1/users/me"]);
  });
  it.each([
    {profile:{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email:"other@example.test"}},
    {profile:{object:"AccountOwnerProfile",provider:"OUTLOOK",email}},
    {profile:owner},
    {mailboxId:"delegated-mailbox"},
  ])("rejects unverifiable or delegated Outlook identity before completion: %j",async({profile,mailboxId})=>{
    const {ops,calls}=harness({identity:{...account,type:"OUTLOOK",connection_params:{mail:{...account.connection_params.mail,...(mailboxId?{mailbox_id:mailboxId}:{})}}},
      owner:profile??{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({status:expect.any(Number)});
    expect(calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it("rejects stale or failed intents without provider side effects",async()=>{
    const {ops,calls}=harness({intent:{...intent,state:"failed"}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});
    expect(calls).toHaveLength(1);
  });
  it.each(["HostedAuthUrl","HostedAuthURL"])("accepts documented %s and creates one single-use Google/Microsoft/IMAP link without mailbox-history sync",async(object)=>{
    const calls:Record<string,unknown>[]=[];
    const provider=createUnipileProvider({...settings,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return json({object,url:"https://account.unipile.com/opaque"});}});
    await provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null});
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({single_use:true,providers:["GOOGLE","OUTLOOK","MAIL"],sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
    expect(calls[0]).not.toHaveProperty("email");
  });
  it("keeps Gmail reconnection pinned to the existing account without offering another provider",async()=>{
    const calls:Record<string,unknown>[]=[];
    const provider=createUnipileProvider({...settings,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return json({object:"HostedAuthUrl",url:"https://account.unipile.com/opaque"});}});
    await provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:"account_1"});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({type:"reconnect",reconnect_account:"account_1",single_use:true,sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
    expect(calls[0]).not.toHaveProperty("providers");
  });
  it("does not retry provider errors and redacts response bodies",async()=>{
    let calls=0;
    const provider=createUnipileProvider({...settings,fetchImpl:async()=>{calls++;return json({error:"provider-SECRET"},429);}});
    await expect(provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null})).rejects.toMatchObject({code:"UNIPILE_HOSTED_HTTP_429"});
    expect(calls).toBe(1);
  });
  it("bounds stalled bodies",async()=>{
    const provider=createUnipileProvider({...settings,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
    await expect(provider.readIdentity("account_1",email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
  });
  it("rejects provider redirect URLs outside the hosted auth origin",async()=>{
    const provider=createUnipileProvider({...settings,fetchImpl:async()=>json({object:"HostedAuthURL",url:"https://attacker.test/"})});
    await expect(provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null})).rejects.toMatchObject({code:"UNIPILE_HOSTED_URL_INVALID"});
  });
});
describe("hosted authorization lifecycle",()=>{
  function authorizationHarness(failure?:"provider"|"save"|"schema",options:{siblings?:unknown[];referenced?:string[];mailbox?:string;expectReconnect?:string;listStatus?:number}={}) {
    const operations:string[]=[],probes:Record<string,unknown>[]=[],failures:string[]=[];
    let current="pending",hostedUrl:string|null=null,providerCalls=0;
    const fetchImpl:typeof fetch=async(url,init)=>{
      if(new URL(String(url)).hostname==="api1.unipile.com") {
        const pathname=new URL(String(url)).pathname;
        if(pathname==="/api/v1/accounts")return json(options.listStatus?{}:{items:options.siblings??[]},options.listStatus??200);
        providerCalls++;
        expect(pathname).toBe("/api/v1/hosted/accounts/link");
        const body=JSON.parse(String(init?.body));
        if(options.expectReconnect)expect(body).toMatchObject({type:"reconnect",reconnect_account:options.expectReconnect,single_use:true});
        else expect(body).toMatchObject({type:"create",providers:["GOOGLE","OUTLOOK","MAIL"],single_use:true,sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
        if(failure==="provider")return json({message:"provider-SECRET https://account.unipile.com/private-token"},401);
        return json({object:failure==="schema"?"HostedAuthLink":"HostedAuthUrl",url:"https://account.unipile.com/opaque"});
      }
      const args=JSON.parse(String(init?.body));operations.push(args.p_operation);
      if(args.p_operation==="intent")return json({...intent,state:current,hosted_url:hostedUrl});
      if(args.p_operation==="issue_link"){
        const claimed=current==="pending";if(claimed)current="issuing";return json({claimed});
      }
      if(args.p_operation==="probe"){
        expect(current).toBe("issuing");probes.push(args.p_payload);
        return json({referenced:options.referenced??[],mailbox:options.mailbox??"free"});
      }
      if(args.p_operation==="save_link") {
        if(failure==="save")return json({code:"PT409",message:"internal private-token detail"},409);
        expect(current).toBe("issuing");hostedUrl=args.p_payload.url;current="ready";
      }
      if(args.p_operation==="fail") {
        expect(args.p_payload.intent_ref).toBe(id);failures.push(String(args.p_payload.failure_code));current="failed";
      }
      return json({ok:true});
    };
    return {ops:createEmailConnectOperations({...settings,fetchImpl}),operations,probes,failures,providerCalls:()=>providerCalls};
  }
  it("persists current OpenAPI success through claim/provider/save and reuses the ready link without another POST",async()=>{
    const h=authorizationHarness();
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.operations).toEqual(["intent","issue_link","probe","save_link"]);
    expect(h.probes).toEqual([{intent_ref:id,email}]);
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.operations).toEqual(["intent","issue_link","probe","save_link","intent"]);
    expect(h.providerCalls()).toBe(1);
  });
  it.each([["provider","UNIPILE_HOSTED_HTTP_401"],["schema","UNIPILE_HOSTED_RESPONSE_INVALID"],["save","EMAIL_LINK_SAVE_FAILED"]] as const)("terminal %s failure preserves safe stage code without leaking bodies or retrying",async(failure,code)=>{
    const h=authorizationHarness(failure);
    const error=await h.ops.authorize(state).catch(error=>error);
    expect(error).toMatchObject({code,status:502});
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-token|provider-SECRET|account\.unipile/);
    expect(h.operations).toEqual(failure==="save"?["intent","issue_link","probe","save_link","fail"]:["intent","issue_link","probe","fail"]);
    expect(h.failures).toEqual(["link_failed"]);
    await expect(h.ops.authorize(state)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED",status:410});
    expect(h.operations.at(-1)).toBe("intent");expect(h.providerCalls()).toBe(1);
  });
  it("reconnects the single unreferenced account already holding this mailbox instead of creating another",async()=>{
    const dup={id:"mail_dup",type:"GOOGLE_OAUTH",connection_params:{mail:{id:"mail_dup",username:email.toUpperCase()}}};
    const h=authorizationHarness(undefined,{siblings:[dup,{...dup,id:"mail_other",connection_params:{mail:{username:"other@example.test"}}}],expectReconnect:"mail_dup"});
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.probes).toEqual([{intent_ref:id,email,account_ids:["mail_dup"]}]);
    expect(h.operations).toEqual(["intent","issue_link","probe","save_link"]);
  });
  it("creates a new account when the matching mailbox account is referenced or ambiguous, or the lookup fails",async()=>{
    const dup={id:"mail_dup",type:"GOOGLE_OAUTH",connection_params:{mail:{username:email}}};
    for(const options of [{siblings:[dup],referenced:["mail_dup"]},{siblings:[dup,{...dup,id:"mail_dup2"}]},{siblings:[dup],listStatus:503}]) {
      const h=authorizationHarness(undefined,options);
      await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
      expect(h.operations).toEqual(["intent","issue_link","probe","save_link"]);expect(h.providerCalls()).toBe(1);
    }
  });
  it("fails before any provider link when the mailbox is live in another workspace",async()=>{
    const h=authorizationHarness(undefined,{mailbox:"taken"});
    await expect(h.ops.authorize(state)).rejects.toMatchObject({code:"EMAIL_ACCOUNT_TAKEN",status:409});
    expect(h.operations).toEqual(["intent","issue_link","probe","fail"]);
    expect(h.failures).toEqual(["account_taken"]);expect(h.providerCalls()).toBe(0);
  });
  it("concurrent authorization contenders obtain at most one provider link",async()=>{
    const h=authorizationHarness();
    const results=await Promise.allSettled([h.ops.authorize(state),h.ops.authorize(state)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(h.providerCalls()).toBe(1);expect(h.operations.filter(op=>op==="save_link")).toHaveLength(1);
  });
});
describe("email API",()=>{
  it("requires authentication and an explicit mailbox-use declaration",async()=>{
    expect((await createApp().request("/v1/email/connect",{method:"POST"})).status).toBe(401);
    const app=createApp({authenticate:async()=>({ok:true,session:{userId:id,client:{}}})});
    const response=await app.request("/v1/email/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspace:"senja",email})});
    expect(response.status).toBe(400);
  });
  it("publishes the email contract and keeps credentials out",async()=>{
    const doc=await (await createApp().request("/openapi.json")).json();
    expect(doc.paths["/v1/email/connect"].post.operationId).toBe("startEmailConnect");
    expect(JSON.stringify(doc)).not.toContain("serverKey");
  });
  it("does not allow response contracts to raise the daily cap or activate sending",async()=>{
    const app=createApp({authenticate:async()=>({ok:true,session:{userId:id,client:{}}}),log:()=>{},startEmailConnect:async()=>({provider:"unipile",channel:"email",workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:11,warmup_required:false,sending_enabled:false,status:"connected",connection_ref:id})});
    const response=await app.request("/v1/email/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspace:"senja",email,mailbox_use:"personal"})});
    expect(response.status).toBe(500);
  });
});

describe("email disconnection",()=>{
  it("requires an authenticated caller and explicit workspace, not account IDs",async()=>{
    expect((await createApp().request("/v1/email/disconnect",{method:"POST"})).status).toBe(401);
    const app=createApp({authenticate:async()=>({ok:true,session:{userId:id,client:{}}})});
    for(const payload of [{},{workspace:"senja",account_id:"other"}]) {
      expect((await app.request("/v1/email/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})).status).toBe(400);
    }
  });
  it("disconnects via the caller JWT capability then returns durable state without contacting provider",async()=>{
    const calls:Record<string,unknown>[]=[];
    const client={rpc:async(name:string,args:Record<string,unknown>)=>{expect(name).toBe("lifty_email_connection");expect(args.p_server_key).toBe(secret);calls.push(args);return {data:{state:"disconnected",workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:10,connection_ref:id,intent_ref:null,account_id:"account_1"},error:null};}};
    const ops=createEmailConnectOperations({...settings,fetchImpl:async()=>{throw new Error("Provider must not be contacted");}});
    const result=await ops.disconnect({userId:id,client},"senja");
    expect(result.status).toBe("disconnected");expect(calls.map(c=>c.p_operation)).toEqual(["disconnect","status"]);
    expect(calls.every(c=>(c.p_payload as {workspace:string}).workspace==="senja")).toBe(true);
  });
  it("rejects cross-workspace disconnect without returning tenant data",async()=>{
    const ops=createEmailConnectOperations(settings);
    await expect(ops.disconnect({userId:id,client:{rpc:async()=>({data:null,error:{code:"PT403",message:"email_workspace_forbidden"}})}},"other")).rejects.toMatchObject({status:403,code:"EMAIL_WORKSPACE_FORBIDDEN"});
  });
});

describe("durable callback reconciliation",()=>{
  function reconciliationHarness(options:{hint?:string|null;health?:string;accountType?:string;profile?:unknown;rpcError?:unknown;providerStatus?:number;hintWorkspace?:string;hintError?:unknown}={}){
    let current="pending",failure:string|null=null;
    const events:string[]=[];
    const stored=()=>({state:current,workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:10,intent_ref:id,connection_ref:current==="connected"?workspace:null,account_id:current==="connected"?"account_1":null,failure_code:failure});
    const client={rpc:async(name:string,args:Record<string,unknown>)=>{
      events.push(`jwt:${name}:${args.p_operation}`);
      if(options.rpcError)return {data:null,error:options.rpcError};
      expect(args.p_server_key).toBe(secret);
      if(name==="lifty_email_callback_hint"){
        expect(args.p_operation).toBe("read");expect(args.p_payload).toEqual({workspace_ref:workspace,intent_ref:id});
        return {data:{workspace_ref:options.hintWorkspace??workspace,intent_ref:id,account_id:options.hint===undefined?"account_1":options.hint},error:options.hintError??null};
      }
      return {data:stored(),error:null};
    }};
    const fetchImpl:typeof fetch=async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path.includes("/api/v1/")){
        events.push(path);
        if(path.endsWith("/users/me")){
          expect(new URL(String(url)).searchParams.get("account_id")).toBe("account_1");
          return json(options.profile??owner);
        }
        expect(path).toBe("/api/v1/accounts/account_1");
        return json({...(options.accountType==="MAIL"?imapAccount:account),type:options.accountType??account.type,sources:account.sources.map(source=>({...source,status:options.health??"OK"}))},options.providerStatus??200);
      }
      expect(path).toBe("/rest/v1/rpc/lifty_email_connection");
      const args=JSON.parse(String(init?.body));events.push(`server:${args.p_operation}`);
      if(args.p_operation==="complete"){
        expect(args.p_payload).toEqual({intent_ref:id,account_id:"account_1",email});current="connected";
      }else if(args.p_operation==="fail"){current="failed";failure=args.p_payload.failure_code;}
      else throw new Error("Unexpected operation");
      return json({ok:true});
    };
    return {ops:createEmailConnectOperations({...settings,fetchImpl}),session:{userId:id,client},events};
  }
  it("reconciles only a member-authorized durable hint, verifies primary, and never repeats completion on the next poll",async()=>{
    const h=reconciliationHarness();
    expect((await h.ops.status(h.session,"senja")).status).toBe("connected");
    expect(h.events.slice(0,6)).toEqual(["jwt:lifty_email_connection:status","jwt:lifty_email_callback_hint:read","/api/v1/accounts/account_1","/api/v1/users/me","server:complete","jwt:lifty_email_connection:status"]);
    expect((await h.ops.status(h.session,"senja")).status).toBe("connected");
    expect(h.events.filter(event=>event==="server:complete")).toHaveLength(1);
  });
  it("does not discover accounts by email when the authenticated callback hint is absent",async()=>{
    const h=reconciliationHarness({hint:null});
    expect((await h.ops.status(h.session,"senja")).status).toBe("pending");
    expect(h.events).toHaveLength(2);
  });
  it.each([{health:"CONNECTING"},{providerStatus:404}])("keeps temporary provider readiness pending without OAuth, failure or completion: %j",async(options)=>{
    const h=reconciliationHarness(options);
    for(let i=0;i<2;i++)expect((await h.ops.status(h.session,"senja")).status).toBe("pending");
    expect(h.events.some(event=>event.startsWith("server:"))).toBe(false);
  });
  it("retains a pending authorization when a provider GET fails",async()=>{
    const h=reconciliationHarness({providerStatus:503});
    await expect(h.ops.status(h.session,"senja")).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(h.events.some(event=>event.startsWith("server:"))).toBe(false);
  });
  it("fails mismatching authenticated primary instead of completing the hinted account",async()=>{
    const h=reconciliationHarness({profile:{...owner,email:"foreign@example.test"}});
    expect(await h.ops.status(h.session,"senja")).toMatchObject({status:"failed",failure_code:"identity_mismatch"});
    expect(h.events).not.toContain("server:complete");
  });
  it.each(["OK","CONNECTING"])("recovers a durable Outlook hint only when health is OK: %s",async(health)=>{
    const h=reconciliationHarness({accountType:"OUTLOOK",health,
      profile:{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email}});
    expect(await h.ops.status(h.session,"senja")).toMatchObject({status:health==="OK"?"connected":"pending"});
    expect((await h.ops.status(h.session,"senja")).status).toBe(health==="OK"?"connected":"pending");
    expect(h.events.filter(event=>event==="server:complete")).toHaveLength(health==="OK"?1:0);
    expect(h.events).not.toContain("server:fail");
    if(health!=="OK")expect(h.events).not.toContain("/api/v1/users/me");
  });
  it.each(["OK","CONNECTING"])("recovers a durable IMAP hint only when health is OK: %s",async(health)=>{
    const h=reconciliationHarness({accountType:"MAIL",health,profile:imapOwner});
    expect((await h.ops.status(h.session,"senja")).status).toBe(health==="OK"?"connected":"pending");
    expect(h.events.filter(event=>event==="server:complete")).toHaveLength(health==="OK"?1:0);
    expect(h.events).not.toContain("server:fail");
  });
  it("rejects membership revocation before provider reads",async()=>{
    const h=reconciliationHarness({rpcError:{code:"PT403",message:"email_workspace_forbidden"}});
    await expect(h.ops.status(h.session,"foreign")).rejects.toMatchObject({code:"EMAIL_WORKSPACE_FORBIDDEN",status:403});
    expect(h.events).toHaveLength(1);
  });
  it.each([{hintWorkspace:"33333333-3333-4333-8333-333333333333"},{hintError:{code:"PT403",message:"email_callback_invalid"}},{hintError:{code:"PT410",message:"email_intent_expired"}}])("rejects foreign or inaccessible hint before provider reads: %j",async(options)=>{
    const h=reconciliationHarness(options);
    await expect(h.ops.status(h.session,"senja")).rejects.toBeDefined();
    expect(h.events).toHaveLength(2);
  });
  it("stops callback processing if durable recording conflicts",async()=>{
    let reads=0;
    const ops=createEmailConnectOperations({...settings,fetchImpl:async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path.includes("/api/v1/")){reads++;throw new Error("No provider read allowed");}
      const args=JSON.parse(String(init?.body));
      if(args.p_operation==="intent")return json(intent);
      expect(path).toBe("/rest/v1/rpc/lifty_email_callback_hint");
      expect(args.p_operation).toBe("record");
      return json({code:"PT409",message:"email_callback_conflict"},409);
    }});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_CALLBACK_CONFLICT",status:409});
    expect(reads).toBe(0);
  });
  it("persists the immutable authenticated callback hint before any readiness failure",async()=>{
    const {ops,calls}=harness({identity:{...account,sources:[{id:"source",status:"CONNECTING"}]}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
    expect(calls).toEqual([{operation:"intent",payload:{intent_ref:id}},{operation:"record",payload:{workspace_ref:workspace,intent_ref:id,account_id:"account_1",callback_name:body.name}}]);
  });
  it.each([[],[{id:"",status:"OK"}],[{id:" ",status:"OK"}],[{id:"duplicate",status:"OK"},{id:"duplicate",status:"OK"}],[{id:"a",status:"OK"},{id:"b",status:"ERROR"}]])("rejects missing, empty, duplicate or unhealthy source identities: %j",async(...sources)=>{
    const {ops,calls}=harness({identity:{...account,sources}});
    await expect(ops.callback(state,body)).rejects.toBeDefined();
    expect(calls.some(call=>call.operation==="complete")).toBe(false);
  });
});

describe("backend beta connection policy",()=>{
  const beta={version:"lifty.personal-beta.v1",revision:id,placement_required:false,habitual_only:true};
  it.each(["personal","outreach"] as const)("returns truthful beta requirements for %s without provider I/O",async mailbox_use=>{
    const ops=createEmailConnectOperations({...settings,fetchImpl:async()=>{throw new Error("no provider I/O on start");}});
    const result=await ops.start({userId:id,client:{rpc:async()=>({error:null,data:{state:"pending",workspace_ref:workspace,email,mailbox_use,daily_limit:10,intent_ref:id,expires_at:intent.expires_at,email_policy:beta}})}},{workspace:"senja",email,mailbox_use});
    expect(result.email_policy).toEqual(beta);expect(result.warmup_required).toBe(false);expect(result.sending_enabled).toBe(false);
  });
  it("rejects forged policy requests before RPC",async()=>{
    const ops=createEmailConnectOperations({...settings,fetchImpl:async()=>{throw Error("unexpected");}});
    await expect(ops.start({userId:id,client:{rpc:async()=>{throw Error("unexpected RPC");}}},{workspace:"senja",email,mailbox_use:"personal",skip_placement:true} as never)).rejects.toThrow();
  });
});

describe("hosted selection and exact-attempt verification", () => {
  it("explains a mailbox ownership conflict without recommending another authorization", async () => {
    const client = { rpc: async () => ({ data: null, error: { code: "PT409", message: "email_account_taken" } }) };
    const { ops } = harness();

    await expect(ops.status({ userId: id, client }, workspace)).rejects.toMatchObject({
      code: "EMAIL_ACCOUNT_TAKEN",
      message: expect.stringContaining("another workspace"),
    });
  });
  it.each([
    ["completed", false],
    ["ready", true],
  ] as const)("acknowledges a used %s authorization without replaying the hosted link", async (intentState, authorizationReceived) => {
    const { ops, calls } = harness({ intent: { ...intent, state: intentState, authorization_received: authorizationReceived } });

    await expect(ops.authorize(state)).resolves.toBe("authorization_received");
    expect(calls.map(call => call.operation)).toEqual(["intent"]);
  });
  it("renders a no-store acknowledgment for a used browser authorization", async () => {
    const app = createApp({ authorizeEmail: async () => "authorization_received", log: () => {} });

    const response = await app.request(`/unipile/start?intent=${state}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("We received your authorization");
  });
  it("starts workspace-only selection and reconnection without requesting a mailbox address or contacting the provider", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { state: "pending", workspace_ref: workspace, email: null, mailbox_use: null, daily_limit: 10,
        intent_ref: id, expires_at: intent.expires_at }, error: null };
    } };
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async () => { throw new Error("Must not read provider"); } });
    const result = await ops.start({ userId: id, client }, { workspace, reconnect: true });
    expect(result).toMatchObject({ status: "pending", email: null, mailbox_use: null, intent_ref: id, expires_at: intent.expires_at });
    expect(calls).toHaveLength(1); expect(calls[0]?.p_payload).toEqual({ workspace, reconnect: true });
  });
  it("requests an unbound selector explicitly after disconnect without authorizing the retained account", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { state: "pending", workspace_ref: workspace, email: null, mailbox_use: null, daily_limit: 10,
        account_id: null, connection_ref: null, provider_selection_required: true,
        intent_ref: id, expires_at: intent.expires_at }, error: null };
    } };
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async () => { throw new Error("No provider request before selection"); } });
    const result = await ops.start({ userId: id, client }, { workspace, reconnect: true, select_account: true });
    expect(result).toMatchObject({ status: "pending", email: null, sending_enabled: false, intent_ref: id });
    expect(openEmailIntent(new URL(result.status === "pending" ? result.connect_url : "").searchParams.get("intent")!, secret)).toBe(id);
    expect(calls).toHaveLength(1); expect(calls[0]?.p_payload).toEqual({ workspace, reconnect: true, select_account: true });
  });
  it.each([
    { state: "connected", account_id: "account_1", connection_ref: workspace },
    { state: "pending", email, account_id: "account_1" },
    { state: "pending", provider_selection_required: false },
    { state: "pending", transport: { api_version: "v1", account_id: "account_1", canonical_account_id: null,
      connection_ref: null, provider_namespace: "legacy", application_id: null, account_scope_id: null, user_id: null,
      v1_account_id: null, owner_profile_id: null, generation: 0, hosted_auth_origin: "https://account.unipile.com" } },
  ])("fails closed if explicit reselection receives a retained or incompatible backend response: %j", async response => {
    const operations: unknown[] = [];
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      operations.push(args.p_operation);
      return { data: { workspace_ref: workspace, email: null, mailbox_use: null, daily_limit: 10,
        provider_selection_required: true, intent_ref: id, expires_at: intent.expires_at, ...response }, error: null };
    } };
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async () => { throw new Error("Must not authorize retained account"); } });
    await expect(ops.start({ userId: id, client }, { workspace, select_account: true })).rejects.toMatchObject({ code: "EMAIL_PROVIDER_SELECTION_UNAVAILABLE" });
    expect(operations).toEqual(["start"]);
  });
  it.each(["email_reselection_requires_disconnect", "email_reselection_pending_work", "email_provider_selection_unavailable"])("returns actionable %s without retrying or disconnecting automatically", async message => {
    const operations: unknown[] = [];
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      operations.push(args.p_operation); return { data: null, error: { code: "PT409", message } };
    } };
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async () => { throw new Error("No provider request"); } });
    await expect(ops.start({ userId: id, client }, { workspace, select_account: true })).rejects.toMatchObject({ status: 409, code: message.toUpperCase() });
    expect(operations).toEqual(["start"]);
  });
  it("keeps explicit reselection free of client-supplied mailbox identity", () => {
    expect(EmailConnectRequest.safeParse({ workspace, select_account: true }).success).toBe(true);
    expect(EmailConnectRequest.safeParse({ workspace, select_account: true, email, mailbox_use: "personal" }).success).toBe(false);
    expect(EmailConnectRequest.safeParse({ workspace, select_account: false, email, mailbox_use: "personal" }).success).toBe(true);
  });
  it("keeps declaration in an explicit browser form POST bound to the same sealed intent", async () => {
    let declared = false; const calls: string[] = [];
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async (_url, init) => {
      const args = JSON.parse(String(init?.body)); calls.push(args.p_operation);
      expect(args.p_payload.intent_ref).toBe(id);
      if (args.p_operation === "declare") { expect(args.p_payload.mailbox_use).toBe("personal"); declared = true; return json({ ok: true }); }
      return json({ ...intent, email: null, selection_required: !declared });
    } });
    const app = createApp({ authorizeEmail: ops.authorize, declareEmail: ops.declare, log: () => {} });
    const page = await app.request(`/unipile/start?intent=${state}`);
    expect(page.status).toBe(200); expect(page.headers.get("referrer-policy")).toBe("strict-origin");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(await page.text()).toContain('type="checkbox"'); expect(calls).toEqual(["intent"]);
    const send = (body: string, origin = "http://localhost") => app.request("/unipile/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body });
    expect((await send(`intent=${state}`)).status).toBe(400);
    expect((await send(`intent=${state}&mailbox_use=personal`, "https://attacker.test")).status).toBe(403);
    expect(declared).toBe(false);
    const response = await send(`intent=${state}&mailbox_use=personal`);
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(intent.hosted_url);
    expect(calls).toEqual(["intent", "declare", "intent"]);
  });
  it("verifies the selected primary mailbox from provider readback without inventing an address", async () => {
    const h = harness({ intent: { ...intent, email: null } });
    await h.ops.callback(state, body);
    expect(h.calls.at(-1)).toEqual({ operation: "complete", payload: { intent_ref: id, account_id: "account_1", email } });
  });
  it.each(["pending", "connected"])("preserves %s authorization and grant on malformed account/owner responses", async initial => {
    for (const malformed of ["account", "owner"]) {
      const operations: string[] = [];
      const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
        operations.push(String(args.p_operation));
        if (String(_name).includes("callback_hint")) return { data: { workspace_ref: workspace, intent_ref: id, account_id: "account_1" }, error: null };
        return { data: { state: initial, workspace_ref: workspace, email, mailbox_use: "personal", daily_limit: 10, intent_ref: id, account_id: "account_1", connection_ref: workspace }, error: null };
      } };
      const ops = createEmailConnectOperations({ ...settings, fetchImpl: async url => {
        if (String(url).includes("users/me")) return json(malformed === "owner" ? { ...owner, aliases: [] } : owner);
        return json(malformed === "account" ? { incomplete: true } : account);
      } });
      await expect(ops.status({ userId: id, client }, workspace)).rejects.toMatchObject({ code: "UNIPILE_UNAVAILABLE" });
      expect(operations).toEqual(initial === "pending" ? ["status", "read"] : ["status"]);
    }
  });
  it("does not reconcile a newer pending intent when verifying an older exact reference", async () => {
    const operations: string[] = [];
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      operations.push(String(args.p_operation));
      return { data: { state: "pending", workspace_ref: workspace, email, mailbox_use: "personal", daily_limit: 10, intent_ref: workspace }, error: null };
    } };
    const ops = createEmailConnectOperations({ ...settings, fetchImpl: async () => { throw new Error("No provider call"); } });
    expect((await ops.status({ userId: id, client }, workspace, id)).status).toBe("pending");
    expect(operations).toEqual(["status"]);
  });
});

describe("unknown email source status", () => {
  it.each(["", "FUTURE_STATUS"])("does not convert %s into a failed grant or attempt", async status => {
    const h = harness({ identity: { ...account, sources: [{ id: "s", status }] } });
    await expect(h.ops.callback(state, body)).rejects.toMatchObject({ code: "UNIPILE_UNAVAILABLE" });
    expect(h.calls.map(call => call.operation)).toEqual(["intent", "record"]);
  });
});

describe("LIF-955 refused mailbox bindings",()=>{
  it("records account_taken when completion is refused and never deletes the mailbox account",async()=>{
    const h=harness({completeError:true});
    await expect(h.ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_ACCOUNT_TAKEN",status:409});
    expect(h.calls.map(call=>call.operation)).toEqual(["intent","record","complete","fail"]);
    expect(h.calls.at(-1)?.payload).toEqual({intent_ref:id,failure_code:"account_taken"});
  });
});
