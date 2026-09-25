import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createEmailAccountOperations } from "../src/email-accounts.js";
import { createSupabaseAuthenticator, getVerifiedSessionToken } from "../src/supabase-auth.js";
import { createProductionApp } from "../src/service.js";
import { createCurrentClient as createApp } from "./current-client.js";
import type { AuthSession } from "../src/app.js";
import { EmailAccountConnectResult, type EmailAccountsOutput, type EmailAccountStatusOutput } from "../src/email-accounts-contracts.js";

const workspace="22222222-2222-4222-8222-222222222222",sender="33333333-3333-4333-8333-333333333333";
const connection="44444444-4444-4444-8444-444444444444",user="11111111-1111-4111-8111-111111111111";
const other="55555555-5555-4555-8555-555555555555",email="david@example.test";
const base="https://project.supabase.test",edge=`${base}/functions/v1/lift-unipile-connect`;
const now=new Date("2026-09-25T12:00:00Z"),iat=now.getTime()/1000;
const envelope={v:1,workspace_id:workspace,workspace_slug:"lift",sender_id:sender,channel:"email",identity:email,iat,exp:iat+3600,nonce:other,issuer_user_id:user};
const attempt=(change:Record<string,unknown>={})=>`${Buffer.from(JSON.stringify({...envelope,...change})).toString("base64url")}.${"a".repeat(43)}`;
const issued=(change:Record<string,unknown>={})=>({provider:"unipile",channel:"email",workspace_ref:workspace,sender_ref:sender,email,
  status:"link_issued",connection_url:`${edge}?t=${attempt()}`,attempt_ref:attempt(),expires_at:new Date((iat+3600)*1000).toISOString(),...change});
const accounts:EmailAccountsOutput={workspace_ref:workspace,workspace_slug:"lift",senders:[{sender_ref:sender,display_name:"David"}],
  accounts:[{connection_ref:connection,sender_ref:sender,email,status:"connected",campaign_send_paused:true}],campaign_release_required:true,required_active_days:21};
const status:EmailAccountStatusOutput={provider:"unipile",channel:"email",workspace_ref:workspace,sender_ref:sender,email,status:"connected",connection_ref:connection,campaign_send_paused:true};
let session:AuthSession,jwt:string,jwks:Awaited<ReturnType<typeof exportJWK>> & {kid:string;alg:string};
beforeAll(async()=>{
  const keys=await generateKeyPair("ES256");
  jwks={...await exportJWK(keys.publicKey),kid:"member",alg:"ES256"};
  jwt=await new SignJWT({role:"authenticated"}).setProtectedHeader({alg:"ES256",kid:"member"}).setSubject(user)
    .setAudience("authenticated").setIssuer(`${base}/auth/v1`).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  const auth=createSupabaseAuthenticator({supabaseUrl:base,publishableKey:"public",jwks:{keys:[jwks]}},
    {fetch:async()=>Response.json(true)});
  const result=await auth(new Request("https://api.lifty.test/v1/email/accounts",{headers:{authorization:`Bearer ${jwt}`}}));
  if(!result.ok)throw Error("fixture auth failed");session=result.session;
});
function harness(body:unknown=issued(),statusCode=200) {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(body,{status:statusCode});};
  return {calls,ops:createEmailAccountOperations({supabaseUrl:base,publishableKey:"public",fetchImpl,now:()=>now})};
}

describe("member email account proxy",()=>{
  it("forwards only the verified caller JWT and public key to the fixed accounts route",async()=>{
    const h=harness(accounts);
    expect(await h.ops.accounts(session,{workspace:"lift"})).toEqual(accounts);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({url:`${edge}/member/accounts?workspace=lift`,init:{method:"GET",redirect:"error",
      headers:{authorization:`Bearer ${jwt}`,apikey:"public"}}});
    expect(h.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(h.calls[0]!.init?.body).toBeUndefined();
    expect(Object.keys(session).sort()).toEqual(["client","userId"]);
    expect(getVerifiedSessionToken(session)).toBe(jwt);
  });
  it("does not forward unverified session objects",async()=>{
    const h=harness();
    await expect(h.ops.connect({userId:user,client:{}},{workspace:"lift",sender_ref:sender,email})).rejects.toMatchObject({status:401});
    expect(h.calls).toEqual([]);
  });
  it("issues a strictly matched link and normalizes the requested address",async()=>{
    const h=harness();
    expect(await h.ops.connect(session,{workspace:"lift",sender_ref:sender,email:email.toUpperCase()})).toEqual(issued());
    expect(h.calls[0]).toMatchObject({url:`${edge}/member/connect`,init:{method:"POST",redirect:"error"}});
    expect(JSON.parse(h.calls[0]!.init!.body as string)).toEqual({workspace:"lift",sender_ref:sender,email});
  });
  it("posts the retained attempt for exact status verification without capabilities in URLs",async()=>{
    const h=harness(status);
    expect(await h.ops.status(session,{workspace,attempt_ref:attempt()})).toEqual(status);
    expect(h.calls[0]).toMatchObject({url:`${edge}/member/connect/status`,init:{method:"POST"}});
    expect(JSON.parse(h.calls[0]!.init!.body as string)).toEqual({workspace,attempt_ref:attempt()});
    expect(h.calls[0]!.url).not.toContain(attempt());
  });
  it.each([
    {connection_url:`https://evil.test/functions/v1/lift-unipile-connect?t=${attempt()}`},
    {connection_url:`${edge}/other?t=${attempt()}`},
    {connection_url:`${edge}?t=${attempt()}&extra=1`},
    {connection_url:`${edge}?t=${attempt()}&t=${attempt()}`},
    {connection_url:`${edge}?t=${attempt()}#fragment`},
    {connection_url:`https://user:password@project.supabase.test/functions/v1/lift-unipile-connect?t=${attempt()}`},
    {connection_url:`${edge}?t=${attempt({nonce:sender})}`},
    {expires_at:new Date((iat+3601)*1000).toISOString()},
    {workspace_ref:other},{sender_ref:other},{email:"different@example.test"},{provider_account_id:"PRIVATE"},
  ])("rejects mismatched or unsafe issued-link response %j",async change=>{
    const h=harness(issued(change));
    await expect(h.ops.connect(session,{workspace:"lift",sender_ref:sender,email})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE"});
    expect(h.calls).toHaveLength(1);
  });
  it.each([{issuer_user_id:other},{workspace_id:other},{workspace_slug:"other"},{sender_id:other},
    {identity:"different@example.test"},{channel:"linkedin"},{iat:iat-3601,exp:iat-1},{iat:iat+61,exp:iat+3661},
    {exp:iat+7200},{extra:"PRIVATE"}])("rejects inconsistent token envelope %j",async change=>{
    const token=attempt(change),exp=typeof change.exp==="number"?change.exp:iat+3600;
    const h=harness(issued({attempt_ref:token,connection_url:`${edge}?t=${token}`,expires_at:new Date(exp*1000).toISOString()}));
    await expect(h.ops.connect(session,{workspace:"lift",sender_ref:sender,email})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE"});
  });
  it.each([{workspace_ref:other},{sender_ref:other},{email:"other@example.test"},{connection_ref:null},
    {campaign_send_paused:null},{provider_account_id:"PRIVATE"}])("rejects a status receipt not proving the retained attempt %j",async change=>{
    const h=harness({...status,...change});
    await expect(h.ops.status(session,{workspace:"lift",attempt_ref:attempt()})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE"});
  });
  it("keeps unknown pause state unknown until a connection is verified",async()=>{
    const h=harness({...status,status:"pending",connection_ref:null,campaign_send_paused:null});
    expect(await h.ops.status(session,{workspace:"lift",attempt_ref:attempt()})).toMatchObject({status:"pending",connection_ref:null,campaign_send_paused:null});
  });
  it.each([{workspace_slug:"other"},{workspace_ref:other,workspace_slug:"other"},{accounts:[{...accounts.accounts[0],status:"unknown"}]},
    {senders:[{sender_ref:sender,display_name:"PRIVATE\n"}]},{provider_payload:"PRIVATE"}])("rejects inconsistent or unsafe account inventory %j",async change=>{
    const h=harness({...accounts,...change});
    await expect(h.ops.accounts(session,{workspace:"lift"})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE"});
  });
  it.each([[401,"unauthorized","UNAUTHORIZED"],[400,"invalid_request","EMAIL_ACCOUNTS_INVALID_REQUEST"],
    [403,"workspace_forbidden","EMAIL_WORKSPACE_FORBIDDEN"],[409,"sender_unavailable","EMAIL_SENDER_UNAVAILABLE"],
    [400,"invalid_attempt","EMAIL_ATTEMPT_INVALID"]] as const)("maps %s %s without provider details",async(http,error,code)=>{
    const h=harness({error},http);
    await expect(h.ops.accounts(session,{workspace:"lift"})).rejects.toMatchObject({status:http,code});
  });
  it("redacts unknown errors, malformed provider responses and transport details",async()=>{
    for(const body of [{error:"PRIVATE"},{error:"workspace_forbidden",reason:"PRIVATE"},"PRIVATE"]) {
      const h=harness(body,502);
      await expect(h.ops.accounts(session,{workspace:"lift"})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:expect.not.stringContaining("PRIVATE")});
    }
    const ops=createEmailAccountOperations({supabaseUrl:base,publishableKey:"public",fetchImpl:async()=>{throw Error(jwt+"PRIVATE");}});
    await expect(ops.accounts(session,{workspace:"lift"})).rejects.toMatchObject({code:"EMAIL_ACCOUNTS_UNAVAILABLE",cause:undefined});
  });
});

describe("explicit member email API routes",()=>{
  const post=(app:ReturnType<typeof createApp>,path:string,body:unknown)=>app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  function app() {
    const founder=vi.fn(async()=>{throw Error("must not resolve a founder workspace");});
    const get=vi.fn(async()=>accounts),connect=vi.fn(async()=>EmailAccountConnectResult.parse(issued())),read=vi.fn(async()=>status);
    const instance=createApp({authenticate:async()=>({ok:true,session}),getWorkspace:founder,
      getEmailAccounts:get,connectEmailAccount:connect,getEmailAccountAttempt:read,log:()=>{}});
    return {instance,founder,get,connect,read};
  }
  it("passes explicit client input without requiring a founder profile",async()=>{
    const h=app();
    const read=await h.instance.request("/v1/email/accounts?workspace=lift");
    expect(read.status).toBe(200);expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual(accounts);
    expect((await post(h.instance,"/v1/email/accounts/connect",{workspace:"lift",sender_ref:sender,email})).status).toBe(200);
    expect((await post(h.instance,"/v1/email/accounts/connect/status",{workspace:"lift",attempt_ref:attempt()})).status).toBe(200);
    expect(h.get).toHaveBeenCalledWith(session,{workspace:"lift"});
    expect(h.connect).toHaveBeenCalledWith(session,{workspace:"lift",sender_ref:sender,email});
    expect(h.read).toHaveBeenCalledWith(session,{workspace:"lift",attempt_ref:attempt()});
    expect(h.founder).not.toHaveBeenCalled();
  });
  it("rejects missing, duplicate or extra selectors and oversized attempts before handlers",async()=>{
    const h=app();
    for(const query of ["","?workspace=lift&workspace=other","?workspace=lift&sender_ref=other"]) {
      expect((await h.instance.request(`/v1/email/accounts${query}`)).status).toBe(400);
    }
    for(const body of [{workspace:"lift",email},{workspace:"lift",sender_ref:sender,email,provider_account_id:"PRIVATE"}]) {
      expect((await post(h.instance,"/v1/email/accounts/connect",body)).status).toBe(400);
    }
    expect((await post(h.instance,"/v1/email/accounts/connect/status",{workspace:"lift",attempt_ref:"x".repeat(9000)})).status).toBe(413);
    expect(h.get).not.toHaveBeenCalled();expect(h.connect).not.toHaveBeenCalled();expect(h.read).not.toHaveBeenCalled();
  });
  it("wires member management in production without founder Unipile settings",async()=>{
    const upstream=vi.fn<typeof fetch>(async url=>String(url).endsWith("lifty_session_active")?Response.json(true):Response.json(accounts));
    vi.stubGlobal("fetch",upstream);
    try {
      const production=createProductionApp({host:"127.0.0.1",port:3000,supabase:{supabaseUrl:base,publishableKey:"public",jwks:{keys:[jwks]}},
        hubspot:{clientId:"client",clientSecret:"secret",publicBaseUrl:"https://api.lifty.test",supabaseUrl:base,publishableKey:"public"},
        slack:null,trigger:{apiUrl:"https://api.trigger.test",secretKey:"secret"}});
      const response=await production.request("/v1/email/accounts?workspace=lift",{headers:{authorization:`Bearer ${jwt}`,"x-lifty-client-contract":"lifty-cli-context.v5"}});
      expect(response.status).toBe(200);expect(await response.json()).toEqual(accounts);
      expect(upstream.mock.calls.map(call=>String(call[0]))).toEqual([`${base}/rest/v1/rpc/lifty_session_active`,`${edge}/member/accounts?workspace=lift`]);
    }finally{vi.unstubAllGlobals();}
  });
});
