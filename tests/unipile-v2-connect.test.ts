import { describe,it,expect } from "vitest";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createLinkedinConnectOperations } from "../src/linkedin-connect.js";
import { sealEmailIntent,emailCallbackName } from "../src/email-state.js";
import { sealLinkedinIntent,linkedinCallbackName } from "../src/linkedin-state.js";
import { unipileV2AuthState } from "../src/unipile-v2-state.js";
import { createCurrentClient } from "./current-client.js";
import { PublicError } from "../src/errors.js";

const id="11111111-1111-4111-8111-111111111111", workspace="22222222-2222-4222-8222-222222222222",connection="33333333-3333-4333-8333-333333333333";
const secret="connection-test-server-key-"+"x".repeat(40),email="founder@example.test";
const expires=new Date(Date.now()+600000).toISOString();
const transport={api_version:"v2",connection_ref:connection,canonical_account_id:"legacy",provider_namespace:"unipile:old",account_id:"acc_test",application_id:"app_test",account_scope_id:null,generation:1,user_id:"owner",v1_account_id:"legacy",hosted_auth_origin:"https://auth.unipile.com"};
function harness(channel:"email"|"linkedin",options:{authorized?:boolean;rawUserId?:string;authorizationId?:string;accountChanges?:Record<string,unknown>;intentState?:string;saveFail?:boolean;dbCompleteDenied?:boolean;missingV2?:boolean;wrongWorkspace?:boolean;statusState?:string;providerFailsOnce?:boolean;hostedStatus?:number;hostedMalformed?:boolean;fresh?:boolean;completeTaken?:boolean;v2Siblings?:string[]}={}) {
  let phase=options.intentState??"ready",status=options.statusState??"pending",reads=0;
  const calls:{operation:string;payload:Record<string,unknown>;caller:boolean}[]=[];
  const http:{url:string;body:Record<string,unknown>|null}[]=[],deleted:string[]=[];
  const authState=channel==="email"?sealEmailIntent(id,secret):sealLinkedinIntent(id,secret);
  const unbound=()=>options.fresh===true && status!=="connected";
  const stored=()=>({state:status,workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:10,account_id:unbound()?null:"legacy",connection_ref:unbound()?null:connection,intent_ref:id,
    profile_id:"owner",profile_url:null,display_name:null,timezone:"UTC",health_status:status==="connected"?"running":"unknown",outbound_enabled:false,
    transport:{...transport,...(options.fresh?{account_id:null,canonical_account_id:null,v1_account_id:null,connection_ref:null,generation:0}:{}),
      user_id:options.rawUserId??transport.user_id,owner_profile_id:channel==="linkedin"?"owner":null},expires_at:expires});
  async function rpc(_name:string,args:Record<string,unknown>,caller:boolean) {
    const operation=String(args.p_operation),payload=args.p_payload as Record<string,unknown>;
    calls.push({operation,payload,caller});
    if(operation==="intent")return {data:{...stored(),state:phase,workspace_ref:options.wrongWorkspace?connection:workspace,
      hosted_url:phase==="ready"?"https://auth.unipile.com/?token=old":null,
      authorization_received:options.authorized??false,authorization_account_id:options.authorized?options.authorizationId??"acc_test":null},error:null};
    if(operation==="issue_link") {const claimed=phase==="pending";phase="issuing";return {data:{claimed},error:null};}
    if(operation==="save_link") {if(options.saveFail)return {data:null,error:{code:"PT409",message:"save unavailable"}};phase="ready";}
    if(operation==="probe")return {data:{referenced:[],mailbox:null},error:null};
    if(operation==="complete") {
      if(options.dbCompleteDenied)return {data:null,error:{code:"PT403",message:`${channel}_workspace_forbidden`}};
      if(options.completeTaken)return {data:null,error:{code:"PT409",message:`${channel}_account_taken`}};
      phase="completed";status="connected";
    }
    if(operation==="fail"){phase="failed";status="failed";}
    return {data:["status","start","disconnect"].includes(operation)?stored():{ok:true},error:null};
  }
  const fetchImpl:typeof fetch=async(url,init)=>{
    const target=String(url);
    if(target.includes("supabase")) {
      const result=await rpc(target.split("/").at(-1)!,JSON.parse(String(init?.body)),false);
      return new Response(JSON.stringify(result.error??result.data),{status:result.error?403:200});
    }
    http.push({url:target,body:init?.body?JSON.parse(String(init.body)):null});
    expect(target).toContain("https://api.unipile.com/v2/");
    if(init?.method==="DELETE"){deleted.push(target);return new Response(JSON.stringify({success:true}));}
    if(target.includes("/v2/accounts/?provider="))return new Response(JSON.stringify({object:"Accounts",has_more:false,
      data:(options.v2Siblings??[]).map(id=>({object:"Account",id,provider:channel==="email"?"google":"linkedin",status:"running",is_locked:false,metadata:{}}))}));
    if(target.endsWith("/auth/link") && options.hostedStatus)return new Response("private provider details",{status:options.hostedStatus});
    if(target.endsWith("/auth/link") && options.hostedMalformed)return new Response("{}");
    if(options.providerFailsOnce && reads++===0)return new Response("{}",{status:503});
    const data=target.endsWith("/auth/link")?{object:"HostedAuthLink",link:"https://auth.unipile.com/?token=created"}
      :target.endsWith("/email-senders")?{data:[{object:"EmailSender",email,is_primary:true,verification_status:"verified"}]}
      :target.includes("/users/")?{object:"UserProfile",provider:"linkedin",id:"owner",type:"individual",display_name:"Founder",specifics:{network_distance:"SELF"}}
      :{object:"Account",id:"acc_test",application_id:"app_test",account_scope_id:null,user_id:options.rawUserId??"owner",provider:channel==="email"?"google":"linkedin",status:"running",is_locked:false,metadata:{v1_account_id:"legacy"},...options.accountChanges};
    return new Response(JSON.stringify(data));
  };
  const settings={dsn:"https://api1.unipile.com:13111",accessToken:"v1-test",serverKey:secret,publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://project.supabase.co",publishableKey:"sb_publishable",fetchImpl,
    ...(options.missingV2?{}:{v2:{accessToken:"v2-test",applicationId:"app_test",hostedAuthOrigins:["https://auth.unipile.com"]}})};
  const ops=channel==="email"?createEmailConnectOperations(settings):createLinkedinConnectOperations(settings);
  const session={userId:id,client:{rpc:(name:string,args:Record<string,unknown>)=>rpc(name,args,true)}};
  return {ops,session,calls,http,deleted,state:authState};
}
describe("V2 LinkedIn hosted diagnostics",()=>{
  for(const status of [429,503])it(`retains safe HTTP ${status} and does not retry`,async()=>{
    const h=harness("linkedin",{intentState:"pending",hostedStatus:status});
    await expect(h.ops.authorize(h.state)).rejects.toMatchObject({code:`UNIPILE_LINKEDIN_HOSTED_HTTP_${status}`});
    expect(h.http).toHaveLength(1);
    expect(h.calls.some(c=>c.operation==="fail")).toBe(true);
  });
  it("retains malformed hosted response diagnostic",async()=>{
    const h=harness("linkedin",{intentState:"pending",hostedMalformed:true});
    await expect(h.ops.authorize(h.state)).rejects.toMatchObject({code:"UNIPILE_LINKEDIN_HOSTED_RESPONSE_INVALID"});
    expect(h.http).toHaveLength(1);
  });
});
for(const channel of ["email","linkedin"] as const)describe(`V2 ${channel} lifecycle`,()=>{
  it("waits for signed lifecycle evidence and never consumes browser hints",async()=>{
    const h=harness(channel);
    await h.ops.v2Return(h.state);
    expect((await h.ops.status(h.session,workspace,id)).status).toBe("pending");
    expect(h.http).toHaveLength(0);
    expect(h.calls.every(c=>["intent","status"].includes(c.operation))).toBe(true);
  });
  it("ends an open attempt when the provider returns an error",async()=>{
    const h=harness(channel);
    await h.ops.v2Return(h.state,true);
    expect(h.calls.find(c=>c.operation==="fail")?.payload).toEqual({intent_ref:id,failure_code:"provider_unavailable"});
    expect(h.calls.some(c=>c.operation==="complete")).toBe(false);
    expect(h.http).toHaveLength(0);
  });
  it("confirms from the return page with signed authorization and a server identity read",async()=>{
    const h=harness(channel,{authorized:true});
    expect(await h.ops.v2Return(h.state)).toEqual({status:"connected",account:channel==="email"?email:"Founder"});
    const complete=h.calls.find(c=>c.operation==="complete");
    expect(complete?.payload).toMatchObject({intent_ref:id,verified_transport:{api_version:"v2",account_id:"acc_test",application_id:"app_test"}});
    expect(complete?.caller).toBe(false);
    expect(h.deleted).toEqual([]);
  });
  it("keeps the return page pending until Unipile's signed authorization arrives",async()=>{
    const h=harness(channel);
    expect(await h.ops.v2Return(h.state)).toEqual({status:"pending"});
    expect(h.http).toHaveLength(0);
  });
  it("reports final attempt states without provider reads",async()=>{
    for(const [intentState,expected] of [["completed",{status:"connected",account:channel==="email"?email:null}],["failed",{status:"failed",reason:"ended"}]] as const){
      const h=harness(channel,{intentState});
      expect(await h.ops.v2Return(h.state)).toEqual(expected);
      expect(h.http).toHaveLength(0);
    }
  });
  it("never deletes a provider account when the return page hits an account-taken refusal",async()=>{
    const h=harness(channel,{authorized:true,completeTaken:true,fresh:true});
    expect(await h.ops.v2Return(h.state)).toEqual({status:"failed",reason:"verification"});
    expect(h.calls.some(c=>c.operation==="fail" && c.payload.failure_code==="account_taken")).toBe(true);
    expect(h.deleted).toEqual([]);
  });
  it("never fails a completed attempt on a late provider error",async()=>{
    const h=harness(channel,{intentState:"completed"});
    await h.ops.v2Return(h.state,true);
    expect(h.calls.map(c=>c.operation)).toEqual(["intent"]);
  });
  it("completes exact pending attempt only with authenticated matching account evidence",async()=>{
    const h=harness(channel,{authorized:true});
    const result=await h.ops.status(h.session,workspace,id);
    expect(result.status).toBe("connected");expect(result).toMatchObject({sending_enabled:false});
    expect(h.calls.find(c=>c.operation==="complete")?.payload).toMatchObject({intent_ref:id,account_id:"legacy",verified_transport:{api_version:"v2",account_id:"acc_test",application_id:"app_test",account_scope_id:null,user_id:"owner",v1_account_id:"legacy"}});
    expect(h.calls.some(c=>c.operation==="record"||c.operation==="read")).toBe(false);
    expect(h.calls.at(-1)?.caller).toBe(true);
  });
  it("does not advance a different requested attempt",async()=>{
    const h=harness(channel,{authorized:true});await h.ops.status(h.session,workspace,connection);
    expect(h.http).toHaveLength(0);expect(h.calls.map(c=>c.operation)).toEqual(["status"]);
  });
  it("refuses V1 callbacks on V2 attempts even with valid old callback HMAC",async()=>{
    const h=harness(channel);
    const name=channel==="email"?emailCallbackName(id,secret):linkedinCallbackName(id,secret);
    await expect(h.ops.callback(h.state,{status:"RECONNECTED",account_id:"legacy",name})).rejects.toMatchObject({code:channel==="email"?"EMAIL_CALLBACK_INVALID":"LINKEDIN_CALLBACK_INVALID"});
    expect(h.http).toHaveLength(0);expect(h.calls.map(c=>c.operation)).toEqual(["intent"]);
  });
  it("persists exact state before provider POST and retains V2 link once",async()=>{
    const h=harness(channel,{intentState:"pending"});
    expect(await h.ops.authorize(h.state)).toBe("https://auth.unipile.com/?token=created");
    expect(h.calls.map(c=>c.operation)).toEqual(["intent","issue_link","auth_state","save_link"]);
    expect(h.calls[2]?.payload.state).toBe(unipileV2AuthState(channel,id,secret));
    expect(h.http[0]?.body?.state).toBe(h.calls[2]?.payload.state);
    expect(h.http[0]?.body).toMatchObject({account_id:"acc_test"});
    expect(h.http[0]?.body).not.toHaveProperty("providers");
    await h.ops.authorize(h.state);expect(h.http).toHaveLength(1);
  });
  it("does not issue another provider POST after durable save failure",async()=>{
    const h=harness(channel,{intentState:"pending",saveFail:true});
    await expect(h.ops.authorize(h.state)).rejects.toBeDefined();
    await expect(h.ops.authorize(h.state)).rejects.toBeDefined();
    expect(h.http).toHaveLength(1);expect(h.calls.at(-2)?.operation).toBe("fail");
  });
  it("never completes a cross-workspace intent or wrong account alias",async()=>{
    for(const options of [{wrongWorkspace:true},{accountChanges:{metadata:{v1_account_id:"foreign"}}},{accountChanges:{application_id:"app_foreign"}}]){
      const h=harness(channel,{authorized:true,...options});
      try {await h.ops.status(h.session,workspace,id);}catch{/* Expected fail closed. */}
      expect(h.calls.some(c=>c.operation==="complete")).toBe(false);
    }
  });
  it("does not attach on readable-account swap in a signed reconnect event",async()=>{
    const h=harness(channel,{authorized:true,authorizationId:"acc_foreign"});
    try {await h.ops.status(h.session,workspace,id);}catch{/* Expected fail closed. */}
    expect(h.http).toHaveLength(0);expect(h.calls.some(c=>c.operation==="complete")).toBe(false);
  });
  it("preserves database membership/disconnect fences after provider verification",async()=>{
    const h=harness(channel,{authorized:true,dbCompleteDenied:true});
    await expect(h.ops.status(h.session,workspace,id)).rejects.toBeDefined();
    expect(h.calls.filter(c=>c.operation==="complete")).toHaveLength(1);
  });
  it("recovers the same signed attempt after temporary provider unavailability",async()=>{
    const h=harness(channel,{authorized:true,providerFailsOnce:true});
    await expect(h.ops.status(h.session,workspace,id)).rejects.toBeDefined();
    expect(h.calls.some(c=>c.operation==="fail")).toBe(false);
    expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
  });
  it("fails closed instead of falling back to V1 when V2 is unconfigured",async()=>{
    const h=harness(channel,{authorized:true,missingV2:true});
    await expect(h.ops.status(h.session,workspace,id)).rejects.toBeDefined();
    expect(h.http).toHaveLength(0);
  });
});
it.each(["email","linkedin"] as const)("V2 %s browser return is branded without claiming connection success",async channel=>{
  const observed:{channel:string;state:string}[]=[];
  const app=createCurrentClient({
    receiveEmailV2Return:async state=>{observed.push({channel:"email",state});},
    receiveLinkedinV2Return:async state=>{observed.push({channel:"linkedin",state});},
  });
  const response=await app.request(`/unipile/v2/${channel}/return?intent=opaque&account_id=foreign&provider=google&state=forged`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  expect(observed).toEqual([{channel,state:"opaque"}]);
  const html=await response.text();
  expect(html).toContain('aria-label="Lifty"');
  expect(html).toContain("<style>");
  expect(html).toContain(channel==="linkedin" ? "Back from LinkedIn" : "Back from your email provider");
  expect(html).toContain("Ask Lifty to verify whether");
  expect(html).toContain("This page does not confirm that your account is connected.");
  expect(html).not.toMatch(/<script\b|<form\b|<a\s/i);
});

it.each(["email","linkedin"] as const)("V2 %s browser return still renders when the intent is missing or rejected",async channel=>{
  const observed:string[]=[];
  const reject=async(state:string)=>{observed.push(state);throw new PublicError({status:state==="foreign" ? 403 : 410,code:state==="foreign" ? "EMAIL_CALLBACK_INVALID" : "EMAIL_INTENT_EXPIRED",message:"Invalid email connection link."});};
  const app=createCurrentClient({receiveEmailV2Return:reject,receiveLinkedinV2Return:reject});
  for(const query of ["","?intent=expired&account_id=acc_new&provider=google&state=lifty-audit","?intent=foreign"]){
    const response=await app.request(`/unipile/v2/${channel}/return${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html=await response.text();
    expect(html).toContain(channel==="linkedin" ? "Back from LinkedIn" : "Back from your email provider");
    expect(html).toContain("This page does not confirm that your account is connected.");
    expect(html).not.toContain("acc_new");
  }
  expect(observed).toEqual(["","expired","foreign"]);
});

it.each(["email","linkedin"] as const)("V2 %s browser return reports a provider error instead of the neutral page",async channel=>{
  const observed:{state:string;providerError:boolean|undefined}[]=[];
  const receive=async(state:string,providerError?:boolean)=>{observed.push({state,providerError});};
  const app=createCurrentClient({receiveEmailV2Return:receive,receiveLinkedinV2Return:receive});
  const cases=[
    {query:"?intent=opaque&error_type=canceled&error_title=Canceled&error_detail=Authentication%20canceled",text:"You stopped before giving access"},
    {query:"?intent=opaque&error_type=consent_denied&error_title=Consent%20denied",text:"You stopped before giving access"},
    {query:"?intent=opaque&error_type=api%2Finternal_error&error_title=Internal&error_detail=acc_existing",text:"could not finish the connection"},
  ];
  for(const {query,text} of cases){
    const response=await app.request(`/unipile/v2/${channel}/return${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html=await response.text();
    expect(html).toContain(channel==="linkedin" ? "Your LinkedIn account did not connect" : "Your email account did not connect");
    expect(html).toContain(text);
    expect(html).toContain("ask Lifty for a new connection link");
    expect(html).not.toContain("acc_existing");
    expect(html).not.toContain("Back from");
    expect(html).not.toMatch(/<script\b|<form\b|<a\s/i);
  }
  expect(observed).toEqual(cases.map(()=>({state:"opaque",providerError:true})));
  const success=await app.request(`/unipile/v2/${channel}/return?intent=opaque&account_id=acc_new&provider=google`);
  expect(await success.text()).toContain("This page does not confirm that your account is connected.");
  expect(observed.at(-1)).toEqual({state:"opaque",providerError:false});
});

it.each(["email","linkedin"] as const)("V2 %s return page confirms, refreshes while pending and stops after a minute",async channel=>{
  const results:Record<string,unknown>={
    ok:{status:"connected",account:"founder<b>@example.test"},
    denied:{status:"failed",reason:"verification"},
    wait:{status:"pending"},
  };
  const receive=async(state:string)=>results[state] as never;
  const app=createCurrentClient({receiveEmailV2Return:receive,receiveLinkedinV2Return:receive});
  const account=channel==="linkedin" ? "LinkedIn account" : "email account";

  const connected=await (await app.request(`/unipile/v2/${channel}/return?intent=ok&account_id=acc_forged`)).text();
  expect(connected).toContain(`Your ${account} is connected`);
  expect(connected).toContain("founder&lt;b&gt;@example.test");
  expect(connected).not.toContain("acc_forged");
  expect(connected).not.toMatch(/http-equiv="refresh"|<script\b/i);

  const failed=await (await app.request(`/unipile/v2/${channel}/return?intent=denied`)).text();
  expect(failed).toContain(`Your ${account} did not connect`);
  expect(failed).toContain("Lifty could not verify the account you chose");

  const pending=await app.request(`/unipile/v2/${channel}/return?intent=wait&account_id=acc_forged&check=4`);
  expect(pending.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  const pendingHtml=await pending.text();
  expect(pendingHtml).toContain(`Confirming your ${account}`);
  expect(pendingHtml).toContain(`<meta http-equiv="refresh" content="3;url=/unipile/v2/${channel}/return?intent=wait&amp;check=5">`);
  expect(pendingHtml).not.toMatch(/acc_forged|<script\b/i);

  const expired=await (await app.request(`/unipile/v2/${channel}/return?intent=wait&check=20`)).text();
  expect(expired).toContain("This page does not confirm that your account is connected.");
  expect(expired).not.toContain("http-equiv");
  const tampered=await (await app.request(`/unipile/v2/${channel}/return?intent=wait&check=-9`)).text();
  expect(tampered).toContain("check=1\"");
});

it.each(["email","linkedin"] as const)("V2 %s browser return shows a provider error even when the intent is rejected",async channel=>{
  const reject=async()=>{throw new PublicError({status:410,code:"EMAIL_INTENT_EXPIRED",message:"Invalid email connection link."});};
  const app=createCurrentClient({receiveEmailV2Return:reject,receiveLinkedinV2Return:reject});
  const response=await app.request(`/unipile/v2/${channel}/return?intent=expired&error_type=canceled`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("did not connect");
});

it.each(["email","linkedin"] as const)("V2 %s browser return still surfaces unexpected failures",async channel=>{
  for(const error of [new Error("database offline"),new PublicError({status:502,code:"EMAIL_CONNECTION_UNAVAILABLE",message:"Connection unavailable."})]){
    const crash=async()=>{throw error;};
    const app=createCurrentClient({receiveEmailV2Return:crash,receiveLinkedinV2Return:crash});
    const response=await app.request(`/unipile/v2/${channel}/return?intent=opaque`);
    expect(response.status).toBe(error instanceof PublicError ? error.status : 500);
    expect(await response.text()).not.toContain("Back from");
  }
});

it("pins LinkedIn health writes to the exact transport generation read",async()=>{
  const h=harness("linkedin",{statusState:"connected"});
  await h.ops.status(h.session,workspace);
  expect(h.calls.find(c=>c.operation==="health")?.payload).toMatchObject({account_id:"legacy",transport_generation:1,transport_api_version:"v2"});
});


it("completes a copied LinkedIn reconnect with separate account and canonical SELF identifiers",async()=>{
  const h=harness("linkedin",{authorized:true,rawUserId:"Old Display Name",accountChanges:{user_id:"Copied Display Name"}});
  expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
  expect(h.calls.find(call=>call.operation==="complete")?.payload).toMatchObject({intent_ref:id,account_id:"legacy",profile_id:"owner",
    verified_transport:{account_id:"acc_test",user_id:"Copied Display Name",owner_profile_id:"owner",v1_account_id:"legacy"}});
  expect(h.http.some(call=>call.url==="https://api.unipile.com/v2/acc_test/users/me")).toBe(true);
});

describe("LIF-955 V2 duplicate provider accounts",()=>{
  it("removes a refused fresh LinkedIn creation at the provider and records account_taken",async()=>{
    const h=harness("linkedin",{authorized:true,fresh:true,completeTaken:true});
    await expect(h.ops.status(h.session,workspace,id)).rejects.toMatchObject({code:"LINKEDIN_ACCOUNT_TAKEN",status:409});
    expect(h.calls.filter(c=>c.operation==="fail").map(c=>c.payload)).toEqual([{intent_ref:id,failure_code:"account_taken"}]);
    expect(h.deleted).toEqual(["https://api.unipile.com/v2/accounts/acc_test"]);
  });
  it("keeps a refused reconnect target",async()=>{
    const h=harness("linkedin",{authorized:true,completeTaken:true});
    await expect(h.ops.status(h.session,workspace,id)).rejects.toMatchObject({code:"LINKEDIN_ACCOUNT_TAKEN"});
    expect(h.deleted).toEqual([]);
    expect(h.calls.at(-1)?.payload).toEqual({intent_ref:id,failure_code:"account_taken"});
  });
  it("removes an unreferenced V2 duplicate of the same SELF profile after a verified binding",async()=>{
    const h=harness("linkedin",{authorized:true,fresh:true,v2Siblings:["acc_dup"]});
    expect((await h.ops.status(h.session,workspace,id)).status).toBe("connected");
    expect(h.calls.filter(c=>c.operation==="probe").map(c=>c.payload)).toEqual([{intent_ref:id,account_ids:["acc_dup"]}]);
    expect(h.deleted).toEqual(["https://api.unipile.com/v2/accounts/acc_dup"]);
  });
  it("reconnects an existing unreferenced Google account holding the mailbox and never deletes mailboxes",async()=>{
    const h=harness("email",{intentState:"pending",fresh:true,v2Siblings:["acc_mail"]});
    await h.ops.authorize(h.state);
    expect(h.http.find(x=>x.url.endsWith("/auth/link"))?.body).toMatchObject({account_id:"acc_mail"});
    expect(h.calls.filter(c=>c.operation==="probe").map(c=>c.payload)).toEqual([{intent_ref:id,email,account_ids:["acc_mail"]}]);
    const refused=harness("email",{authorized:true,fresh:true,completeTaken:true});
    await expect(refused.ops.status(refused.session,workspace,id)).rejects.toMatchObject({code:"EMAIL_ACCOUNT_TAKEN",status:409});
    expect(refused.deleted).toEqual([]);
    expect(refused.calls.at(-1)?.payload).toEqual({intent_ref:id,failure_code:"account_taken"});
  });
});
