import { describe,expect,it,vi } from "vitest";
import { Hono } from "hono";
import { createWarmupSetup,DEFAULT_WARMUP_POLICY,hashSetupSecret } from "../src/warmup-setup.js";
import { createWarmupSetupRouter } from "../src/warmup-setup-routes.js";

const state="a".repeat(43),browser="b".repeat(43),email="founder@company.test";
const consent="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=mailivery&response_type=code&state=PRIVATE_CONSENT_STATE";
const transport={api_version:"v2" as const,connection_ref:"44444444-4444-4444-8444-444444444444",canonical_account_id:"acc_owner",
  provider_namespace:"unipile:v2:app_lifty",account_id:"acc_owner",application_id:"app_lifty",account_scope_id:null,
  user_id:"owner",owner_profile_id:null,v1_account_id:null,generation:2,hosted_auth_origin:"https://connect.lifty.test"};
const baseRecord={email,workspace_ref:"22222222-2222-4222-8222-222222222222",sender_ref:"33333333-3333-4333-8333-333333333333",
  expires_at:"2030-01-01T00:00:00Z",state:"draft",policy:DEFAULT_WARMUP_POLICY,first_name:"Ada",last_name:"Lovelace",mailbox_use:"personal",transport};
function harness(options:{url?:string;lostProvider?:boolean;lostSave?:boolean;identify?:"google"|"microsoft";warming?:boolean}={}) {
  let method:string|null=null,dispatched=false,url:string|null=null,saves=0;
  const calls:{operation:string;payload:Record<string,unknown>}[]=[],providerBodies:unknown[]=[];
  const identifyMailbox=vi.fn(async()=>options.identify??"microsoft");
  const verifyWarmup=vi.fn(async()=>{});
  const rpc=vi.fn(async(operation:string,payload:Record<string,unknown>)=>{
    calls.push({operation,payload});
    if(operation.startsWith("microsoft_")&&(payload.oauth_hash!==hashSetupSecret(state)||payload.browser_hash!==hashSetupSecret(browser)))throw Error("foreign attempt");
    if(operation==="identify")method=String(payload.method);
    if(operation==="choose")method=String(payload.method);
    let dispatch=false,verify_at:null|string=null;
    if(operation==="microsoft_prepare") {dispatch=!dispatched;dispatched=true;method="microsoft";}
    if(operation==="microsoft_link") {url=String(payload.url);if(options.lostSave&&++saves===1)throw Error("accepted save response lost");}
    if(operation==="microsoft_status"&&url){verify_at="2026-10-08T20:00:00Z";}
    return {...baseRecord,method,state:dispatched?"dispatched":"draft",dispatch,microsoft_url:url,verify_at};
  });
  const fetchImpl:typeof fetch=vi.fn(async(input,init)=>{
    if(String(input).endsWith("lifty_warmup_browser_receipt"))return Response.json(options.warming
      ? {status:"connected",account:email,placement:{when:"now",notify:["email"]}}
      : {status:"pending",attention:url?"microsoft_sign_in":dispatched?"microsoft_recovery":"microsoft_preparing"});
    expect(String(input)).toBe("https://app.mailivery.io/api/v1/campaigns/ms-graph");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    providerBodies.push(JSON.parse(String(init?.body)));
    if(options.lostProvider)throw Error("PRIVATE_VENDOR_ERROR");
    return Response.json({success:true,data:{url:options.url??consent}});
  });
  const setup=createWarmupSetup({serverKey:"k".repeat(32),publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://db.test",
    publishableKey:"public",googleClientId:"google",googleClientSecret:"secret",mailivery:{apiKey:"key"}},
    {rpc,fetchImpl,identifyMailbox,verifyWarmup});
  const app=new Hono().route("/warmup",createWarmupSetupRouter(setup));
  return {setup,app,rpc,identifyMailbox,verifyWarmup,calls,providerBodies};
}
const cookie=`__Host-lifty-warmup-browser=${browser}`;
const headers={origin:"https://api.lifty.test","content-type":"application/json","x-lifty-connection":"1",cookie};
describe("Microsoft warmup uses one provider-aware, recoverable consent attempt",()=>{
  it.each(["google","microsoft"] as const)("selects %s from authenticated mailbox evidence, never the email domain",async provider=>{
    const h=harness({identify:provider});
    const page=await h.setup.read(state);
    expect(page.method).toBe(provider);
    expect(h.identifyMailbox).toHaveBeenCalledExactlyOnceWith(transport,email);
    expect(h.calls.find(x=>x.operation==="identify")?.payload).toEqual({intent_hash:hashSetupSecret(state),method:provider,transport});
    const target=new URL(await h.setup.choose(state,browser));
    expect(target.origin).toBe(provider==="microsoft"?"https://api.lifty.test":"https://accounts.google.com");
    if(provider==="microsoft")expect(target.pathname+target.search).toMatch(/^\/warmup\/microsoft\/return\?state=.+&prepare=1$/);
    expect(h.providerBodies).toEqual([]);
  });
  it("returns the shared shell before provider work and records exactly one Microsoft link request across reloads",async()=>{
    const h=harness();
    const page=await h.app.request(`https://api.lifty.test/warmup/microsoft/return?state=${state}&prepare=1`,{headers:{cookie}});
    expect(page.status).toBe(200);expect(h.calls).toEqual([]);expect(h.providerBodies).toEqual([]);
    expect(await page.text()).toContain('data-microsoft="true"');
    await Promise.all([h.setup.prepareMicrosoft(state,browser),h.setup.prepareMicrosoft(state,browser)]);
    expect(h.providerBodies).toEqual([{email,first_name:"Ada",last_name:"Lovelace",email_per_day:22,response_rate:30,warmup_audience_type:"inherit",
      meta:{tags:`lifty-ws:${baseRecord.workspace_ref},lifty-sender:${baseRecord.sender_ref}`}}]);
    const link=await h.app.request(`https://api.lifty.test/warmup/microsoft/sign-in?state=${state}`,{headers:{cookie}});
    expect(link.status).toBe(303);expect(link.headers.get("location")).toBe(consent);
    expect(h.verifyWarmup).toHaveBeenCalledTimes(1);
    await h.setup.microsoftStatus(state,browser);expect(h.verifyWarmup).toHaveBeenCalledTimes(2);
    expect(h.verifyWarmup.mock.calls[0]).toEqual(h.verifyWarmup.mock.calls[1]);
    expect(JSON.stringify(h.providerBodies)).not.toMatch(/token|password|secret/i);
  });
  it("recovers a lost link-save response by saving that exact link again, without repeating the vendor call",async()=>{
    const h=harness({lostSave:true});
    await expect(h.setup.prepareMicrosoft(state,browser)).resolves.toBeUndefined();
    expect(h.providerBodies).toHaveLength(1);
    const saves=h.calls.filter(x=>x.operation==="microsoft_link");expect(saves).toHaveLength(2);expect(saves[0]).toEqual(saves[1]);
    expect(await h.setup.microsoftLink(state,browser)).toBe(consent);
  });
  it("keeps an accepted-but-lost provider response pending without replay, false failure or private diagnostics",async()=>{
    const h=harness({lostProvider:true});
    for(let i=0;i<2;i++){
      const response=await h.app.request("https://api.lifty.test/warmup/microsoft/return/process",{method:"POST",headers,body:JSON.stringify({state})});
      expect(await response.json()).toEqual({status:"pending",attention:"microsoft_recovery"});
    }
    expect(h.providerBodies).toHaveLength(1);
    const status=await h.app.request("https://api.lifty.test/warmup/microsoft/return/status",{method:"POST",headers,body:JSON.stringify({state})});
    expect(await status.text()).not.toContain("PRIVATE");
  });
  it.each([
    "https://evil.test/authorize?state=x&client_id=x",
    consent.replace("login.microsoftonline.com","login.microsoftonline.com.evil.test"),
    consent+"&access_token=PRIVATE",consent+"&%63ode=PRIVATE",consent+"#PRIVATE",consent.replace("https://","https://user:password@"),
  ])("rejects an unsafe authorization URL before retaining it: %s",async url=>{
    const h=harness({url});await expect(h.setup.prepareMicrosoft(state,browser)).rejects.toMatchObject({code:"WARMUP_HANDOFF_PENDING"});
    expect(h.calls.some(x=>x.operation==="microsoft_link")).toBe(false);
    await h.setup.prepareMicrosoft(state,browser);expect(h.providerBodies).toHaveLength(1);
  });
  it("rejects a foreign browser and Google authorization codes before Microsoft provider work",async()=>{
    const h=harness();
    await expect(h.setup.prepareMicrosoft(state,"c".repeat(43))).rejects.toMatchObject({code:"WARMUP_SETUP_UNAVAILABLE"});
    const response=await h.app.request("https://api.lifty.test/warmup/microsoft/return/process",{method:"POST",headers,body:JSON.stringify({state,code:"PRIVATE_CODE"})});
    expect(await response.json()).toEqual({status:"failed",reason:"invalid"});expect(h.providerBodies).toEqual([]);
  });
  it("returns authoritative late warmup success and placement timing without another verification dispatch",async()=>{
    const h=harness({warming:true});
    const response=await h.app.request("https://api.lifty.test/warmup/microsoft/return/status",{method:"POST",headers,body:JSON.stringify({state})});
    expect(await response.json()).toEqual({status:"connected",account:email,placement:{when:"now",notify:["email"]}});
    expect(h.providerBodies).toEqual([]);expect(h.verifyWarmup).not.toHaveBeenCalled();
  });
});
