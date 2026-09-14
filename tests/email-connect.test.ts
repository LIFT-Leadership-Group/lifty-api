import { describe,it,expect } from "vitest";
import { createEmailConnectOperations } from "../src/email-connect.js";
import { createUnipileProvider } from "../src/unipile-provider.js";
import { sealEmailIntent,openEmailIntent,emailCallbackName } from "../src/email-state.js";
import { createApp } from "../src/app.js";

const id="11111111-1111-4111-8111-111111111111", workspace="22222222-2222-4222-8222-222222222222";
const secret="server-key-"+"x".repeat(40), email="founder@example.test";
const state=sealEmailIntent(id,secret);
const settings={dsn:"https://api1.unipile.com:13111",accessToken:"provider-SECRET",serverKey:secret,publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://project.supabase.co",publishableKey:"sb_public"};
const account={id:"account_1",type:"GOOGLE_OAUTH",connection_params:{mail:{id:"mail_1",username:email}},sources:[{id:"mail_1",status:"OK"}]};
const intent={state:"ready",intent_ref:id,workspace_ref:workspace,email,expires_at:new Date(Date.now()+120000).toISOString(),account_id:null,hosted_url:"https://account.unipile.com/example"};
const body={status:"CREATION_SUCCESS",account_id:"account_1",name:emailCallbackName(id,secret)};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
function harness(options:{identity?:unknown;intent?:unknown;status?:number}={}){
  const calls:{operation:string;payload:Record<string,unknown>}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
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
    expect(calls.map(c=>c.operation)).toEqual(["intent"]);
  });
  it("rejects wrong IDs, SMTP/IMAP ambiguity and unrelated healthy sources",async()=>{
    for(const identity of [{...account,id:"different"},{...account,type:"MAIL",connection_params:{mail:{smtp_user:email,imap_user:"other@example.test"}}}]){
      const {ops,calls}=harness({identity}); await expect(ops.callback(state,body)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
      expect(calls.some(c=>c.operation==="complete")).toBe(false);
    }
    const {ops}=harness({identity:{...account,sources:[{id:"different",status:"OK"}]}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_PROVIDER_NOT_READY"});
  });
  it("rejects stale or failed intents without provider side effects",async()=>{
    const {ops,calls}=harness({intent:{...intent,state:"failed"}});
    await expect(ops.callback(state,body)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});
    expect(calls).toHaveLength(1);
  });
  it("creates one single-use mail-only link without mailbox-history sync",async()=>{
    const calls:Record<string,unknown>[]=[];
    const provider=createUnipileProvider({...settings,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return json({object:"HostedAuthURL",url:"https://account.unipile.com/opaque"});}});
    await provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null});
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({single_use:true,providers:"*:MAILING",sync_limit:{MAILING:"NO_HISTORY_SYNC"}});
    expect(calls[0]).not.toHaveProperty("email");
  });
  it("does not retry provider errors and redacts response bodies",async()=>{
    let calls=0;
    const provider=createUnipileProvider({...settings,fetchImpl:async()=>{calls++;return json({error:"provider-SECRET"},429);}});
    await expect(provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null})).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(calls).toBe(1);
  });
  it("bounds stalled bodies",async()=>{
    const provider=createUnipileProvider({...settings,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
    await expect(provider.readIdentity("account_1",email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
  });
  it("rejects provider redirect URLs outside the hosted auth origin",async()=>{
    const provider=createUnipileProvider({...settings,fetchImpl:async()=>json({object:"HostedAuthURL",url:"https://attacker.test/"})});
    await expect(provider.createLink({correlation:"opaque",notifyUrl:"https://api.lifty.test/callback",expiresAt:intent.expires_at,reconnectId:null})).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
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
