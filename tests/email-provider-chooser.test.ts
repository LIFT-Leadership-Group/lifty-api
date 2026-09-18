import {describe,it,expect} from "vitest";
import {createEmailConnectOperations} from "../src/email-connect.js";
import {sealEmailIntent,emailCallbackName} from "../src/email-state.js";
import {createCurrentClient} from "./current-client.js";
import type {HostedEmailProvider} from "../src/email-contracts.js";

const id="11111111-1111-4111-8111-111111111111",workspace="22222222-2222-4222-8222-222222222222";
const key="chooser-test-server-key-"+"x".repeat(40),state=sealEmailIntent(id,key),email="owner@example.test";
const expiry=new Date(Date.now()+600000).toISOString();
const v1={api_version:"v1",connection_ref:null,canonical_account_id:null,provider_namespace:"legacy",account_id:null,
  application_id:null,account_scope_id:null,user_id:null,v1_account_id:null,owner_profile_id:null,generation:0,hosted_auth_origin:"https://account.unipile.com"};
const v2={...v1,api_version:"v2",provider_namespace:"unipile:v2:app_test",application_id:"app_test",hosted_auth_origin:"https://auth.lifty.test"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function harness(options:{actual?:HostedEmailProvider;legacy?:boolean;retained?:boolean;expired?:boolean;hint?:boolean;authorized?:boolean;ownerChanged?:boolean;delegated?:boolean;copiedAccount?:boolean;staleStatus?:"pre_choice"|"fixed";completeDuringPoll?:boolean}={}) {
  let selected:HostedEmailProvider|null=null,phase="pending",declared=false,hosted:string|null=null,connected=false;
  const calls:{op:string;payload:Record<string,unknown>}[]=[],http:{url:string;body:Record<string,unknown>|null}[]=[];
  const transport=()=>selected==="google"?v2:v1;
  const stored=()=>({state:connected?"connected":phase==="failed"?"failed":"pending",workspace_ref:workspace,email:connected?email:null,
    mailbox_use:"personal",daily_limit:10,account_id:connected?"account_1":null,connection_ref:connected?workspace:null,intent_ref:id,
    expires_at:expiry,transport:transport(),provider_selection_required:!options.legacy&&!selected,email_provider:selected});
  const intent=()=>({...stored(),state:phase,account_id:options.retained?"account_old":connected?"account_1":null,hosted_url:hosted,selection_required:!declared,
    authorization_received:options.authorized??false,authorization_account_id:options.authorized?"account_1":null});
  function rpc(op:string,payload:Record<string,unknown>) {
    calls.push({op,payload});
    const deny=(message:string)=>({data:null,error:{code:message==="email_intent_expired"?"PT410":"PT409",message}});
    if(options.expired)return deny("email_intent_expired");
    if(op==="start")return {data:stored(),error:null};
    if(op==="intent") {
      if(options.completeDuringPoll && calls.some(call=>call.op==="status")){phase="completed";connected=true;}
      return {data:intent(),error:null};
    }
    if(op==="status")return {data:options.staleStatus&&!connected?{...stored(),transport:v1,
      provider_selection_required:options.staleStatus==="pre_choice",email_provider:options.staleStatus==="pre_choice"?null:selected}:stored(),error:null};
    if(op==="read")return {data:{workspace_ref:workspace,intent_ref:id,account_id:options.hint?"account_1":null},error:null};
    if(op==="declare"){
      const choice=payload.email_provider as HostedEmailProvider|undefined;
      if(options.legacy&&choice)return deny("email_provider_conflict");
      if(!options.legacy&&!choice)return deny("email_provider_required");
      if(selected&&choice!==selected)return deny("email_provider_conflict");
      if(!selected&&choice)selected=choice;
      declared=true;
    }
    if(op==="issue_link"){
      const claimed=phase==="pending"&&(options.legacy||selected!==null);if(claimed)phase="issuing";
      return {data:{claimed},error:null};
    }
    if(op==="save_link"){hosted=String(payload.url);phase="ready";}
    if(op==="complete"){expect(payload.email_provider).toBe(selected);phase="completed";connected=true;}
    if(op==="fail")phase="failed";
    return {data:{ok:true},error:null};
  }
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes("supabase")){
      const request=JSON.parse(String(init?.body)),result=rpc(request.p_operation,request.p_payload);
      return json(result.error??result.data,result.error?Number(result.error.code.slice(2)):200);
    }
    const body=init?.body?JSON.parse(String(init.body)):null;http.push({url,body});
    if(url.endsWith("/auth/link"))return json({object:"HostedAuthLink",link:"https://auth.lifty.test/?token=fake"});
    if(url.endsWith("/hosted/accounts/link"))return json({object:"HostedAuthUrl",url:"https://account.unipile.com/?token=fake"});
    const actual=options.actual??selected??"google";
    if(url.includes("/v2/accounts/"))return json({object:"Account",id:"account_1",application_id:"app_test",account_scope_id:null,user_id:"owner",
      provider:actual,status:"running",is_locked:false,metadata:options.copiedAccount?{v1_account_id:"retained_v1_account"}:{}});
    if(url.includes("/email-senders"))return json({data:[{object:"EmailSender",email,is_primary:true,verification_status:"verified"}]});
    if(url.includes("/accounts/"))return json({id:"account_1",type:actual==="google"?"GOOGLE_OAUTH":actual==="outlook"?"OUTLOOK":"MAIL",
      connection_params:{mail:actual==="imap"?{imap_user:email,imap_host:"imap.test",imap_port:993,smtp_user:email,smtp_host:"smtp.test",smtp_port:465}:{id:"mail_id",username:email,...(options.delegated?{mailbox_id:"shared-mailbox"}:{})}},sources:[{id:"source",status:"OK"}]});
    if(url.includes("/users/me"))return json(actual==="imap"?{object:"AccountOwnerProfile",provider:"IMAP",connection_params:{imap:{username:options.ownerChanged?"other@example.test":email,host:"imap.test",port:993},smtp:{username:email,host:"smtp.test",port:465}}}:
      actual==="outlook"?{object:"AccountOwnerProfile",provider:"OUTLOOK",id:"owner",email:options.ownerChanged?"other@example.test":email}:{object:"AccountOwnerProfile",provider:"GMAIL",email,aliases:[{email,is_primary:true}]});
    throw Error("Unexpected network path");
  };
  const ops=createEmailConnectOperations({dsn:"https://api1.unipile.com:13111",accessToken:"v1-test",serverKey:key,publicBaseUrl:"https://api.lifty.test",
    supabaseUrl:"https://project.supabase.co",publishableKey:"public-test",fetchImpl,
    v2:{accessToken:"v2-test",applicationId:"app_test",hostedAuthOrigins:["https://auth.lifty.test"]}});
  const app=createCurrentClient({authorizeEmail:ops.authorize,declareEmail:ops.declare,unipileV2HostedAuthOrigins:["https://auth.lifty.test"],log:()=>{}});
  const session={userId:id,client:{rpc:async(_name:string,args:Record<string,unknown>)=>rpc(String(args.p_operation),args.p_payload as Record<string,unknown>)}};
  const submit=(body:string,headers:Record<string,string>={})=>app.request("/unipile/start",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",origin:"http://localhost",...headers},body});
  return {ops,app,calls,http,session,submit,intent,select:(choice:HostedEmailProvider)=>ops.declare(state,choice)};
}
describe("fresh hosted email provider choice",()=>{
  it("opens the new selector after explicit reselection, then forwards copied Google proof for canonical reuse",async()=>{
    const h=harness({authorized:true,copiedAccount:true});
    const started=await h.ops.start(h.session,{workspace,reconnect:true,select_account:true});
    expect(started.status).toBe("pending");
    if(started.status!=="pending")throw Error("expected pending selection");
    const url=new URL(started.connect_url);
    const response=await h.app.request(url.pathname+url.search),html=await response.text();
    expect(response.status).toBe(200);
    for(const provider of ["google","outlook","imap"])expect(html).toContain(`value="${provider}"`);
    expect(h.http).toHaveLength(0);
    expect(h.calls[0]).toEqual({op:"start",payload:{workspace,reconnect:true,select_account:true}});
    await h.select("google");
    expect(h.http[0]?.body).toMatchObject({providers:["google"]});
    expect(h.http[0]?.body).not.toHaveProperty("account_id");
    expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
    // The API forwards authenticated V2 metadata, never invents a canonical ID
    // from the alias. The DB must resolve exact retained binding ownership.
    expect(h.calls.find(c=>c.op==="complete")?.payload).toMatchObject({intent_ref:id,account_id:"account_1",email,
      email_provider:"google",verified_transport:{api_version:"v2",account_id:"account_1",application_id:"app_test",
        account_scope_id:null,user_id:"owner",v1_account_id:"retained_v1_account"}});
  });
  it("renders all providers on Lifty without issuing a vendor link and preserves the declaration",async()=>{
    const h=harness(),response=await h.app.request(`/unipile/start?intent=${state}`),html=await response.text();
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    for(const label of ["Google (Gmail or Google Workspace)","Microsoft (Outlook or Microsoft 365)","Other email (IMAP/SMTP)","It is not a new or dedicated outreach mailbox."])expect(html).toContain(label);
    expect(html).toContain('class="brand" aria-label="Lifty"');
    // Opaque intent values can randomly contain V1/V2; branding is visible copy.
    expect(html.replace(/<[^>]+>/g," ")).not.toMatch(/\b(?:Unipile|V1|V2)\b/);expect(h.http).toHaveLength(0);
  });
  it.each(["google","outlook","imap"] as const)("freezes %s before one correct provider POST and reuses same-choice retries",async(choice)=>{
    const h=harness();const response=await h.submit(`intent=${state}&mailbox_use=personal&email_provider=${choice}`);
    expect(response.status).toBe(303);const result=response.headers.get("location"),before=h.intent();
    expect(h.http).toHaveLength(1);expect(h.calls.findIndex(c=>c.op==="declare")).toBeLessThan(h.calls.findIndex(c=>c.op==="issue_link"));
    expect(h.http[0]?.body?.providers).toEqual([choice==="google"?"google":choice==="outlook"?"OUTLOOK":"MAIL"]);
    expect(h.http[0]?.url).toContain(choice==="google"?"/v2/auth/link":"/api/v1/hosted/accounts/link");
    expect(await h.select(choice)).toBe(result);expect(h.http).toHaveLength(1);expect(h.intent()).toEqual(before);
    if(choice==="google")expect(h.calls.map(c=>c.op)).toContain("auth_state");else expect(h.calls.map(c=>c.op)).not.toContain("auth_state");
  });
  it("rejects concurrent different choices before a second provider request",async()=>{
    const h=harness();const results=await Promise.allSettled([h.select("google"),h.select("outlook")]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(h.http).toHaveLength(1);
    expect(h.intent().email_provider).toBe("google");expect(h.http[0]?.body?.providers).toEqual(["google"]);
  });
  it("rejects duplicate authorize claims without sending a second provider POST",async()=>{
    const h=harness();await h.select("imap");await Promise.all([h.ops.authorize(state),h.ops.authorize(state)]);expect(h.http).toHaveLength(1);
  });
  it("rejects missing choice and never bypasses the issuance gate",async()=>{
    const h=harness();await expect(h.ops.declare(state)).rejects.toMatchObject({code:"EMAIL_PROVIDER_REQUIRED"});
    await expect(h.ops.authorize(state)).rejects.toMatchObject({code:"EMAIL_PROVIDER_REQUIRED"});expect(h.http).toHaveLength(0);
    expect(h.calls.some(c=>c.op==="issue_link")).toBe(false);
  });
  it("never renders the chooser for an inconsistent retained-account flag",async()=>{
    const h=harness({retained:true});await expect(h.ops.authorize(state)).rejects.toMatchObject({code:"EMAIL_PROVIDER_CONFLICT"});expect(h.http).toHaveLength(0);
  });
  it("keeps old forms and hosted provider list compatible; an injected selection cannot reroute them",async()=>{
    const h=harness({legacy:true});const response=await h.app.request(`/unipile/start?intent=${state}`);
    expect(await response.text()).not.toContain('name="email_provider"');
    await expect(h.select("google")).rejects.toMatchObject({code:"EMAIL_PROVIDER_CONFLICT"});
    await h.ops.declare(state);expect(h.http[0]?.body?.providers).toEqual(["GOOGLE","OUTLOOK","MAIL"]);
  });
  it("rejects forged and expired sealed intents before provider use",async()=>{
    const h=harness();await expect(h.ops.declare(state+"x","google")).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});expect(h.calls).toHaveLength(0);
    const expired=harness({expired:true});await expect(expired.select("google")).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});expect(expired.http).toHaveLength(0);
  });
  it.each([
    [`intent=${state}&mailbox_use=personal&email_provider=google&email_provider=outlook`,{},400],
    [`intent=${state}&mailbox_use=personal&email_provider=other`,{},400],
    [`intent=${state}&mailbox_use=personal&email_provider=google&application_id=foreign`,{},400],
    [`intent=${state}&email_provider=google`,{},400],
    [`intent=${state}&mailbox_use=personal&email_provider=google`,{origin:"https://foreign.test"},403],
    [`intent=${state}&mailbox_use=personal&email_provider=google`,{"sec-fetch-site":"cross-site"},403],
    [`intent=${state}&mailbox_use=personal&email_provider=google`,{"content-type":"application/json"},400],
  ] as const)("rejects invalid or cross-site chooser form",async(body,headers,status)=>{
    const h=harness();expect((await h.submit(body,headers)).status).toBe(status);expect(h.calls).toHaveLength(0);expect(h.http).toHaveLength(0);
  });
  it.each(["outlook","imap"] as const)("maps hosted %s selection to authenticated account and owner-profile types before completion",async(choice)=>{
    const h=harness();await h.select(choice);await h.ops.callback(state,{status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,key)});
    expect(h.calls.find(c=>c.op==="complete")?.payload).toMatchObject({intent_ref:id,account_id:"account_1",email,email_provider:choice});
  });
  it.each(["callback","poll"])("wrong authenticated provider cannot complete through %s",async(path)=>{
    const h=harness({actual:"google",hint:true});await h.select("outlook");
    if(path==="callback")await expect(h.ops.callback(state,{status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,key)})).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    else expect((await h.ops.status(h.session,workspace,id)).status).toBe("failed");
    expect(h.calls.some(c=>c.op==="complete")).toBe(false);expect(h.calls.find(c=>c.op==="fail")?.payload.failure_code).toBe("identity_mismatch");
  });
  it("completes selected Google only after signed lifecycle evidence and authenticated owner readback",async()=>{
    const h=harness({authorized:true});await h.select("google");expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
    expect(h.calls.find(c=>c.op==="complete")?.payload).toMatchObject({email_provider:"google",verified_transport:{api_version:"v2",account_id:"account_1",application_id:"app_test"}});
  });
});


it.each(["outlook","imap"] as const)("provider selection never bypasses %s owner proof",async(choice)=>{
  const h=harness({ownerChanged:true});await h.select(choice);
  await expect(h.ops.callback(state,{status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,key)})).rejects.toBeDefined();
  expect(h.calls.some(c=>c.op==="complete")).toBe(false);
});
it("Microsoft selection still rejects a delegated Outlook mailbox",async()=>{
  const h=harness({delegated:true});await h.select("outlook");
  await expect(h.ops.callback(state,{status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,key)})).rejects.toMatchObject({code:"UNIPILE_MAILBOX_UNVERIFIABLE"});
  expect(h.calls.some(c=>c.op==="complete")).toBe(false);
});
it("Google selection cannot fall back to an Outlook V2 account",async()=>{
  const h=harness({actual:"outlook",authorized:true});await h.select("google");
  expect((await h.ops.status(h.session,workspace,id)).status).toBe("failed");
  expect(h.calls.some(c=>c.op==="complete")).toBe(false);
});

it("a completed same-provider form retry acknowledges receipt without issuing another link",async()=>{
  const h=harness();await h.select("imap");
  await h.ops.callback(state,{status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,key)});
  const before=h.http.length;
  const response=await h.submit(`intent=${state}&mailbox_use=personal&email_provider=imap`);
  expect(response.status).toBe(200);expect(await response.text()).toContain("We received your authorization");
  expect(h.http).toHaveLength(before);expect(h.intent().expires_at).toBe(expiry);
});

it("accepts only the exact unbound chooser transition committed during a status poll",async()=>{
  const h=harness({authorized:true,staleStatus:"pre_choice"});await h.select("google");
  expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
  expect(h.calls.find(c=>c.op==="complete")?.payload).toMatchObject({email_provider:"google",verified_transport:{api_version:"v2",account_id:"account_1"}});
  expect(h.http.slice(1).every(call=>call.url.startsWith("https://api.unipile.com/v2/"))).toBe(true);
});
it("still rejects transport changes for a previously fixed intent",async()=>{
  const h=harness({authorized:true,staleStatus:"fixed"});await h.select("google");const before=h.http.length;
  await expect(h.ops.status(h.session,workspace,id)).rejects.toMatchObject({code:"EMAIL_CALLBACK_INVALID"});
  expect(h.http).toHaveLength(before);expect(h.calls.some(c=>c.op==="complete")).toBe(false);
});

it("refreshes caller-authorized state once when the chosen intent completes during a pre-choice poll",async()=>{
  const h=harness({staleStatus:"pre_choice",completeDuringPoll:true});await h.select("google");
  expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
  expect(h.calls.filter(c=>c.op==="status")).toHaveLength(2);
  expect(h.calls.some(c=>c.op==="complete"||c.op==="fail")).toBe(false);
  expect(h.http.slice(1).map(call=>call.url)).toEqual(["https://api.unipile.com/v2/accounts/account_1","https://api.unipile.com/v2/account_1/email-senders"]);
});
