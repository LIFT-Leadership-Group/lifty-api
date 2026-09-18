import { describe,it,expect } from "vitest";
import { createUnipileV2Provider } from "../src/unipile-v2-provider.js";
import { UnipileTransport } from "../src/unipile-transport.js";
import { versionedHostedAuthUrl } from "../src/hosted-auth-branding.js";

const transport:UnipileTransport={api_version:"v2",connection_ref:null,canonical_account_id:"legacy_account",provider_namespace:"unipile:legacy",
  account_id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",generation:1,owner_profile_id:null,user_id:"owner",v1_account_id:"legacy_account",hosted_auth_origin:"https://connect-v2.lifty.test"};
const email="founder@example.test";
const account={object:"Account",id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",user_id:"owner",
  provider:"google",status:"running",is_locked:false,metadata:{v1_account_id:"legacy_account",products_connection_status:{gmail:"running"}}};
const senders={data:[{object:"EmailSender",email,is_primary:true,verification_status:"verified"}]};
const profile={object:"UserProfile",provider:"linkedin",id:"owner",type:"individual",display_name:"Founder",public_identifier:"founder",specifics:{network_distance:"SELF"}};
function harness(options:{account?:unknown;senders?:unknown;profile?:unknown;link?:string;status?:number;body?:Response}={}) {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    expect(init?.headers).toMatchObject({"X-API-KEY":"v2-test-key"});
    expect(init?.redirect).toBe("error");
    if(options.body)return options.body;
    const result=String(url).endsWith("auth/link") ? {object:"HostedAuthLink",link:options.link??"https://connect-v2.lifty.test/?token=opaque"}
      : String(url).includes("email-senders") ? options.senders??senders
      : String(url).includes("/users/") ? options.profile??profile : options.account??account;
    return new Response(JSON.stringify(result),{status:options.status??200});
  };
  return {calls,provider:createUnipileV2Provider({accessToken:"v2-test-key",applicationId:"app_test",hostedAuthOrigins:["https://auth.unipile.com","https://connect-v2.lifty.test"],fetchImpl})};
}
describe("Unipile V2 authenticated contract",()=>{
  it("retains canonical legacy identity after exact application/scope/owner/alias readback",async()=>{
    const h=harness();
    expect(await h.provider.readEmailIdentity("acc_test",transport,email)).toEqual({accountId:"legacy_account",email,type:"GOOGLE_OAUTH",healthy:true,
      verifiedTransport:{api_version:"v2",account_id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",user_id:"owner",owner_profile_id:null,v1_account_id:"legacy_account"}});
    expect(h.calls.map(c=>c.url)).toEqual(["https://api.unipile.com/v2/accounts/acc_test","https://api.unipile.com/v2/acc_test/email-senders"]);
  });
  it.each([
    {id:"foreign"},{application_id:"app_foreign"},{account_scope_id:"foreign"},{account_scope_id:null},{user_id:"other"},
    {metadata:{v1_account_id:"other"}},{metadata:{}},{provider:"linkedin"},
  ])("rejects authentic but incorrectly bound account %j",async(change)=>{
    const h=harness({account:{...account,...change}});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    expect(h.calls).toHaveLength(1);
  });
  it("does not invent a V1 alias for a new V2-only account",async()=>{
    const h=harness({account:{...account,metadata:{}}});
    const identity=await h.provider.readEmailIdentity("acc_test",{...transport,provider_namespace:"unipile:v2:app_test",canonical_account_id:null,account_id:null,user_id:null,v1_account_id:null},email);
    expect(identity.accountId).toBe("acc_test");expect(identity.verifiedTransport.v1_account_id).toBeNull();
  });
  it.each(["outlook","imap"])("does not substitute Gmail evidence for unverified V2 %s policy",async(provider)=>{
    const h=harness({account:{...account,provider}});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_MAILBOX_UNVERIFIABLE"});
    expect(h.calls).toHaveLength(1);
  });
  it.each([
    {data:[]},{data:[...senders.data,...senders.data]},
    {data:[{...senders.data[0],is_primary:false}]},{data:[{...senders.data[0],verification_status:"unknown"}]},
    {...senders,next_cursor:"more"},{...senders,total_count:2},
  ])("fails closed on ambiguous/incomplete primary address evidence %j",async(senders)=>{
    await expect(harness({senders}).provider.readEmailIdentity("acc_test",transport,email)).rejects.toBeDefined();
  });
  it("rejects an alias even when a provider profile contains it",async()=>{
    await expect(harness().provider.readEmailIdentity("acc_test",transport,"alias@example.test")).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
  });
  it.each([{status:"partial"},{status:"degraded"},{status:"disconnected"},{status:"errored"},{is_locked:true},{metadata:{...account.metadata,products_connection_status:{gmail:"disconnected"}}}])("never reports unhealthy account as running %j",async(change)=>{
    expect((await harness({account:{...account,...change}}).provider.readEmailIdentity("acc_test",transport,email)).healthy).toBe(false);
  });
  it("uses an independent self profile for LinkedIn identity",async()=>{
    const h=harness({account:{...account,provider:"linkedin"}});
    const identity=await h.provider.readLinkedinIdentity("acc_test",{...transport,owner_profile_id:"owner"},"owner");
    expect(identity).toMatchObject({accountId:"legacy_account",profileId:"owner",profileUrl:"https://www.linkedin.com/in/founder/",healthy:true});
    expect(h.calls[1]?.url).toBe("https://api.unipile.com/v2/acc_test/users/me");
  });
  it.each([{id:"foreign"},{provider:"mock"},{type:"organization"},{specifics:{network_distance:"FIRST_DEGREE"}},{specifics:{}}])("rejects wrong LinkedIn owner profile %j",async(change)=>{
    await expect(harness({account:{...account,provider:"linkedin"},profile:{...profile,...change}}).provider.readLinkedinIdentity("acc_test",{...transport,owner_profile_id:"owner"},"owner")).rejects.toBeDefined();
  });
  it("produces distinct create and reconnect bodies with the snapshotted domain",async()=>{
    for(const reconnect of [false,true]){
      const h=harness();await h.provider.createLink({channel:"email",state:"opaque-state",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport:{...transport,account_id:reconnect?"acc_test":null}});
      const body=JSON.parse(String(h.calls[0]?.init?.body));
      expect(body).toEqual({...(reconnect?{account_id:"acc_test"}:{providers:["google"]}),account_scope_id:"scope_test",domain:"connect-v2.lifty.test",
        state:"opaque-state",redirect_uri:"https://api.lifty.test/return",expires_on:"2026-09-18T00:00:00.000Z"});
      expect(body).not.toHaveProperty("notify_url");
    }
  });
  it.each(["https://account.unipile.com/?token=x","https://auth.unipile.com/?token=x","http://connect-v2.lifty.test/?token=x","https://connect-v2.lifty.test:444/?token=x","https://user@connect-v2.lifty.test/?token=x","https://connect-v2.lifty.test/?token=x#fragment","https://evil.test/?token=x"])("rejects wrong hosted URL %s",async(link)=>{
    await expect(harness({link}).provider.createLink({channel:"linkedin",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport})).rejects.toMatchObject({code:"UNIPILE_HOSTED_URL_INVALID"});
  });
  it("preserves V1 links and returns V2 links unchanged across configured domains",()=>{
    const origins=["https://auth.unipile.com","https://connect-v2.lifty.test","https://old-v2.lifty.test"];
    expect(versionedHostedAuthUrl("https://account.unipile.com/?opaque=old","https://connect.lifty.test",origins)).toBe("https://connect.lifty.test/?opaque=old");
    for(const origin of origins)expect(versionedHostedAuthUrl(`${origin}/?opaque=old`,"https://connect.lifty.test",origins)).toBe(`${origin}/?opaque=old`);
    expect(versionedHostedAuthUrl("https://foreign.test/?opaque=x","https://connect.lifty.test",origins)).toBeNull();
  });
  it("never retries or exposes errors containing provider secrets",async()=>{
    const h=harness({status:503});
    await expect(h.provider.createLink({channel:"email",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport})).rejects.toMatchObject({code:"UNIPILE_HOSTED_HTTP_503"});
    expect(h.calls).toHaveLength(1);
  });
});

describe("V2 bounded HTTP",()=>{
  it("aborts a response body that never completes without retry",async()=>{
    let requests=0;
    const provider=createUnipileV2Provider({accessToken:"v2-test",applicationId:"app_test",hostedAuthOrigins:[transport.hosted_auth_origin],timeoutMs:20,
      fetchImpl:async()=>{requests++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("{"));}}));}});
    await expect(provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(requests).toBe(1);
  });
  it("caps bodies even when a server ignores content length",async()=>{
    const h=harness({body:new Response("x".repeat(1_048_577))});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(h.calls).toHaveLength(1);
  });
  it("rejects invalid JSON and unknown status without exposing the response",async()=>{
    const h=harness({body:new Response("secret provider diagnostic")});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    await expect(harness({account:{...account,status:"new_future_state"}}).provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
  });
});


describe("V2 LinkedIn copied owner evidence",()=>{
  const copied={...transport,user_id:"Display Name",owner_profile_id:"owner"};
  const raw={...account,user_id:"Display Name",provider:"linkedin"};
  it("keeps raw account metadata separate from the retained authenticated SELF owner",async()=>{
    const h=harness({account:raw});
    const result=await h.provider.readLinkedinIdentity("acc_test",copied,"owner");
    expect(result).toMatchObject({accountId:"legacy_account",profileId:"owner",healthy:true,
      verifiedTransport:{user_id:"Display Name",owner_profile_id:"owner",v1_account_id:"legacy_account"}});
    expect(h.calls.map(call=>call.url)).toEqual(["https://api.unipile.com/v2/accounts/acc_test","https://api.unipile.com/v2/acc_test/users/me"]);
  });
  it.each([
    {binding:{user_id:"changed"},expected:"owner",response:profile},
    {binding:{owner_profile_id:"foreign"},expected:"owner",response:profile},
    {binding:{},expected:"foreign",response:profile},
    {binding:{owner_profile_id:null},expected:"owner",response:profile},
    {binding:{},expected:"owner",response:{...profile,id:"foreign"}},
    {binding:{},expected:"owner",response:{...profile,specifics:{network_distance:"FIRST_DEGREE"}}},
  ])("rejects mismatched or absent owner evidence %j",async({binding,expected,response})=>{
    await expect(harness({account:raw,profile:response}).provider.readLinkedinIdentity("acc_test",{...copied,...binding},expected)).rejects.toBeDefined();
  });
  it("establishes a new V2-only owner solely from authenticated SELF",async()=>{
    const h=harness({account:{...raw,metadata:{}}});
    const result=await h.provider.readLinkedinIdentity("acc_test",{...copied,canonical_account_id:null,connection_ref:null,
      account_id:null,provider_namespace:"unipile:v2:app_test",v1_account_id:null,user_id:null,owner_profile_id:null});
    expect(result).toMatchObject({accountId:"acc_test",profileId:"owner",verifiedTransport:{user_id:"Display Name",owner_profile_id:"owner",v1_account_id:null}});
  });
  it("reports an established disconnected owner without pretending a fresh SELF proof",async()=>{
    const h=harness({account:{...raw,status:"disconnected"}});
    expect(await h.provider.readLinkedinIdentity("acc_test",copied,"owner")).toMatchObject({profileId:"owner",healthy:false,
      healthStatus:"disconnected",verifiedTransport:{user_id:"Display Name",owner_profile_id:null}});
    expect(h.calls).toHaveLength(1);
  });
  it("does not invent an owner for a disconnected new connection",async()=>{
    const h=harness({account:{...raw,status:"disconnected",metadata:{}}});
    await expect(h.provider.readLinkedinIdentity("acc_test",{...copied,canonical_account_id:null,account_id:null,
      provider_namespace:"unipile:v2:app_test",v1_account_id:null,user_id:null,owner_profile_id:null})).rejects.toBeDefined();
    expect(h.calls).toHaveLength(1);
  });
  it("accepts historical V1 and Google transport snapshots without the additive owner field",()=>{
    const {owner_profile_id:_,...old}=transport;
    expect(UnipileTransport.parse(old).owner_profile_id).toBeNull();
    expect(UnipileTransport.parse({...old,api_version:"v1"}).owner_profile_id).toBeNull();
  });
});
