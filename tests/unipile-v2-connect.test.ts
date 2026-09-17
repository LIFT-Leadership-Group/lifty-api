import { describe,it,expect } from "vitest";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createLinkedinConnectOperations } from "../src/linkedin-connect.js";
import { sealEmailIntent,emailCallbackName } from "../src/email-state.js";
import { sealLinkedinIntent,linkedinCallbackName } from "../src/linkedin-state.js";
import { unipileV2AuthState } from "../src/unipile-v2-state.js";
import { createCurrentClient } from "./current-client.js";

const id="11111111-1111-4111-8111-111111111111", workspace="22222222-2222-4222-8222-222222222222",connection="33333333-3333-4333-8333-333333333333";
const secret="connection-test-server-key-"+"x".repeat(40),email="founder@example.test";
const expires=new Date(Date.now()+600000).toISOString();
const transport={api_version:"v2",connection_ref:connection,canonical_account_id:"legacy",provider_namespace:"unipile:old",account_id:"acc_test",application_id:"app_test",account_scope_id:null,generation:1,user_id:"owner",v1_account_id:"legacy",hosted_auth_origin:"https://auth.unipile.com"};
function harness(channel:"email"|"linkedin",options:{authorized?:boolean;authorizationId?:string;accountChanges?:Record<string,unknown>;intentState?:string;saveFail?:boolean;dbCompleteDenied?:boolean;missingV2?:boolean;wrongWorkspace?:boolean;statusState?:string;providerFailsOnce?:boolean;hostedStatus?:number;hostedMalformed?:boolean}={}) {
  let phase=options.intentState??"ready",status=options.statusState??"pending",reads=0;
  const calls:{operation:string;payload:Record<string,unknown>;caller:boolean}[]=[];
  const http:{url:string;body:Record<string,unknown>|null}[]=[];
  const authState=channel==="email"?sealEmailIntent(id,secret):sealLinkedinIntent(id,secret);
  const stored=()=>({state:status,workspace_ref:workspace,email,mailbox_use:"personal",daily_limit:10,account_id:"legacy",connection_ref:connection,intent_ref:id,
    profile_id:"owner",profile_url:null,display_name:null,timezone:"UTC",health_status:status==="connected"?"running":"unknown",outbound_enabled:false,
    transport,expires_at:expires});
  async function rpc(_name:string,args:Record<string,unknown>,caller:boolean) {
    const operation=String(args.p_operation),payload=args.p_payload as Record<string,unknown>;
    calls.push({operation,payload,caller});
    if(operation==="intent")return {data:{...stored(),state:phase,workspace_ref:options.wrongWorkspace?connection:workspace,
      hosted_url:phase==="ready"?"https://auth.unipile.com/?token=old":null,
      authorization_received:options.authorized??false,authorization_account_id:options.authorized?options.authorizationId??"acc_test":null},error:null};
    if(operation==="issue_link") {const claimed=phase==="pending";phase="issuing";return {data:{claimed},error:null};}
    if(operation==="save_link") {if(options.saveFail)return {data:null,error:{code:"PT409",message:"save unavailable"}};phase="ready";}
    if(operation==="complete") {
      if(options.dbCompleteDenied)return {data:null,error:{code:"PT403",message:`${channel}_workspace_forbidden`}};
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
    if(target.endsWith("/auth/link") && options.hostedStatus)return new Response("private provider details",{status:options.hostedStatus});
    if(target.endsWith("/auth/link") && options.hostedMalformed)return new Response("{}");
    if(options.providerFailsOnce && reads++===0)return new Response("{}",{status:503});
    const data=target.endsWith("/auth/link")?{object:"HostedAuthLink",link:"https://auth.unipile.com/?token=created"}
      :target.endsWith("/email-senders")?{data:[{object:"EmailSender",email,is_primary:true,verification_status:"verified"}]}
      :target.includes("/users/")?{object:"UserProfile",provider:"linkedin",id:"owner",type:"individual",display_name:"Founder",specifics:{network_distance:"SELF"}}
      :{object:"Account",id:"acc_test",application_id:"app_test",account_scope_id:null,user_id:"owner",provider:channel==="email"?"google":"linkedin",status:"running",is_locked:false,metadata:{v1_account_id:"legacy"},...options.accountChanges};
    return new Response(JSON.stringify(data));
  };
  const settings={dsn:"https://api1.unipile.com:13111",accessToken:"v1-test",serverKey:secret,publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://project.supabase.co",publishableKey:"sb_publishable",fetchImpl,
    ...(options.missingV2?{}:{v2:{accessToken:"v2-test",applicationId:"app_test",hostedAuthOrigins:["https://auth.unipile.com"]}})};
  const ops=channel==="email"?createEmailConnectOperations(settings):createLinkedinConnectOperations(settings);
  const session={userId:id,client:{rpc:(name:string,args:Record<string,unknown>)=>rpc(name,args,true)}};
  return {ops,session,calls,http,state:authState};
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
it("V2 browser return ignores forged account/provider fields and never displays success",async()=>{
  const observed:string[]=[];
  const app=createCurrentClient({receiveEmailV2Return:async state=>{observed.push(state);}});
  const response=await app.request("/unipile/v2/email/return?intent=opaque&account_id=foreign&provider=google&state=forged");
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(observed).toEqual(["opaque"]);expect(await response.text()).toContain("check your connection status");
});

it("pins LinkedIn health writes to the exact transport generation read",async()=>{
  const h=harness("linkedin",{statusState:"connected"});
  await h.ops.status(h.session,workspace);
  expect(h.calls.find(c=>c.operation==="health")?.payload).toMatchObject({account_id:"legacy",transport_generation:1,transport_api_version:"v2"});
});
