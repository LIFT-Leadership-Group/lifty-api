import { describe,it,expect } from "vitest";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createUnipileProvider } from "../src/unipile-provider.js";
import { sealEmailIntent,openEmailIntent,emailCallbackName } from "../src/email-state.js";
import { createApp } from "../src/app.js";

const id="11111111-1111-4111-8111-111111111111", workspace="22222222-2222-4222-8222-222222222222";
const secret="server-key-"+"x".repeat(40), email="founder@example.test";
const state=sealEmailIntent(id,secret);
const settings={dsn:"https://api1.unipile.com:13111",accessToken:"provider-SECRET",serverKey:secret,publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://project.supabase.co",publishableKey:"sb_public"};
const account={id:"account_1",type:"GOOGLE_OAUTH",connection_params:{mail:{id:"mail_1",username:email}},sources:[{id:"source_a",status:"OK"},{id:"source_b",status:"OK"}]};
const owner={object:"AccountOwnerProfile",provider:"GMAIL",email,aliases:[{email,is_primary:true}]};
const intent={state:"ready",intent_ref:id,workspace_ref:workspace,email,expires_at:new Date(Date.now()+120000).toISOString(),account_id:null,hosted_url:"https://account.unipile.com/example"};
const body={status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,secret)};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
function harness(options:{identity?:unknown;owner?:unknown;intent?:unknown;status?:number}={}){
  const calls:{operation:string;payload:Record<string,unknown>}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
    if(String(url).includes("/users/me?")){expect(new URL(String(url)).searchParams.get("account_id")).toBe("account_1");return json(options.owner??owner);}
    if(String(url).includes("/accounts/"))return json(options.identity??account,options.status??200);
    const args=JSON.parse(String(init?.body));
    expect(args.p_server_key).toBe(secret); calls.push({operation:args.p_operation,payload:args.p_payload});
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
  it("confirms exact mailbox and source health before completing a tenant-bound intent",async()=>{
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
      const {ops,calls}=harness({identity}); await expect(ops.callback(state,body)).rejects.toMatchObject({code:identity.type==="MAIL"?"UNIPILE_MAILBOX_UNVERIFIABLE":"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
    const {ops}=harness({identity:{...account,sources:[{id:"different",status:"CONNECTING"}]}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
  });
  it("rejects matching IMAP/SMTP usernames without pretending they prove physical identity",async()=>{
    const {ops,calls}=harness({identity:{...account,type:"MAIL",connection_params:{mail:{imap_user:email,smtp_user:email}}}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_MAILBOX_UNVERIFIABLE",message:expect.stringContaining("IMAP/SMTP")});
    expect(calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it("requires the exact authenticated primary, not a matching login or default SendAs alias",async()=>{
    for(const profile of [
      {...owner,email:"primary@example.test"},
      {...owner,aliases:[]},
      {...owner,aliases:[{email,is_default:true}]},
      {...owner,aliases:[{email,is_primary:true},{email,is_primary:true}]},
      {...owner,aliases:[{email,is_primary:false},{email:"primary@example.test",is_primary:true}]},
      {object:"AccountOwnerProfile",provider:"OUTLOOK",email,id:"other-provider-id"},
    ]) {
      const {ops,calls}=harness({owner:profile});
      await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
  });
  it("does not infer dots, plus tags or custom-domain alias equivalence",async()=>{
    for(const primary of ["founder+alias@example.test","f.ounder@example.test","founder@other.test"]) {
      const {ops,calls}=harness({owner:{...owner,email:primary,aliases:[{email:primary,is_primary:true}]}});
      await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
  });
  it("requires Outlook owner profile email and id rather than a configured UPN",async()=>{
    const {ops,calls}=harness({identity:{...account,type:"OUTLOOK"},owner:{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner-id",email,user_principal_name:"alias@example.test"}});
    await ops.callback(state,body);expect(calls.at(-1)?.operation).toBe("complete");
    const missing=harness({identity:{...account,type:"OUTLOOK"},owner:{object:"AccountOwnerProfile",provider:"OUTLOOK",email}});
    await expect(missing.ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
  });
  it("rejects stale or failed intents without provider side effects",async()=>{
    const {ops,calls}=harness({intent:{...intent,state:"failed"}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});
    expect(calls).toHaveLength(1);
  });
  it.each(["HostedAuthUrl","HostedAuthURL"])("accepts documented %s and creates one single-use mail-only link without mailbox-history sync",async(object)=>{
    const calls:Record<string,unknown>[]=[];
    const provider=createUnipileProvider({...settings,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return json({object,url:"https://account.unipile.com/opaque"});}});
    await provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null});
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({single_use:true,providers:["GOOGLE","OUTLOOK"],sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
    expect(calls[0]).not.toHaveProperty("email");
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
  function authorizationHarness(failure?:"provider"|"save"|"schema") {
    const operations:string[]=[];
    let current="pending",hostedUrl:string|null=null,providerCalls=0;
    const fetchImpl:typeof fetch=async(url,init)=>{
      if(new URL(String(url)).hostname==="api1.unipile.com") {
        providerCalls++;
        expect(new URL(String(url)).pathname).toBe("/api/v1/hosted/accounts/link");
        const body=JSON.parse(String(init?.body));
        expect(body).toMatchObject({providers:["GOOGLE","OUTLOOK"],single_use:true,sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
        if(failure==="provider")return json({message:"provider-SECRET https://account.unipile.com/private-token"},401);
        return json({object:failure==="schema"?"HostedAuthLink":"HostedAuthUrl",url:"https://account.unipile.com/opaque"});
      }
      const args=JSON.parse(String(init?.body));operations.push(args.p_operation);
      if(args.p_operation==="intent")return json({...intent,state:current,hosted_url:hostedUrl});
      if(args.p_operation==="issue_link"){
        const claimed=current==="pending";if(claimed)current="issuing";return json({claimed});
      }
      if(args.p_operation==="save_link") {
        if(failure==="save")return json({code:"PT409",message:"internal private-token detail"},409);
        expect(current).toBe("issuing");hostedUrl=args.p_payload.url;current="ready";
      }
      if(args.p_operation==="fail") {
        expect(args.p_payload).toEqual({intent_ref:id,failure_code:"link_failed"});current="failed";
      }
      return json({ok:true});
    };
    return {ops:createEmailConnectOperations({...settings,fetchImpl}),operations,providerCalls:()=>providerCalls};
  }
  it("persists current OpenAPI success through claim/provider/save and reuses the ready link without another POST",async()=>{
    const h=authorizationHarness();
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.operations).toEqual(["intent","issue_link","save_link"]);
    await expect(h.ops.authorize(state)).resolves.toBe("https://account.unipile.com/opaque");
    expect(h.operations).toEqual(["intent","issue_link","save_link","intent"]);
    expect(h.providerCalls()).toBe(1);
  });
  it.each([["provider","UNIPILE_HOSTED_HTTP_401"],["schema","UNIPILE_HOSTED_RESPONSE_INVALID"],["save","EMAIL_LINK_SAVE_FAILED"]] as const)("terminal %s failure preserves safe stage code without leaking bodies or retrying",async(failure,code)=>{
    const h=authorizationHarness(failure);
    const error=await h.ops.authorize(state).catch(error=>error);
    expect(error).toMatchObject({code,status:502});
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-token|provider-SECRET|account\.unipile/);
    expect(h.operations).toEqual(failure==="save"?["intent","issue_link","save_link","fail"]:["intent","issue_link","fail"]);
    await expect(h.ops.authorize(state)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED",status:410});
    expect(h.operations.at(-1)).toBe("intent");expect(h.providerCalls()).toBe(1);
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
  function reconciliationHarness(options:{hint?:string|null;health?:string;profile?:unknown;rpcError?:unknown;providerStatus?:number;hintWorkspace?:string;hintError?:unknown}={}){
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
        return json({...account,sources:account.sources.map(source=>({...source,status:options.health??"OK"}))},options.providerStatus??200);
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
  it.each([{health:"CONNECTING"},{providerStatus:503},{providerStatus:404}])("keeps temporary provider readiness pending without OAuth, failure or completion: %j",async(options)=>{
    const h=reconciliationHarness(options);
    for(let i=0;i<2;i++)expect((await h.ops.status(h.session,"senja")).status).toBe("pending");
    expect(h.events.some(event=>event.startsWith("server:"))).toBe(false);
  });
  it("fails mismatching authenticated primary instead of completing the hinted account",async()=>{
    const h=reconciliationHarness({profile:{...owner,email:"foreign@example.test"}});
    expect(await h.ops.status(h.session,"senja")).toMatchObject({status:"failed",failure_code:"identity_mismatch"});
    expect(h.events).not.toContain("server:complete");
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
