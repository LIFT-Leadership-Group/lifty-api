import { expect, it } from "vitest";
import { createClientEmailOperations } from "../src/client-email-connect.js";
import { createCurrentClient as createApp } from "./current-client.js";
const workspace="22222222-2222-4222-8222-222222222222", sender="33333333-3333-4333-8333-333333333333";
const user="11111111-1111-4111-8111-111111111111", intent="44444444-4444-4444-8444-444444444444",connection="55555555-5555-4555-8555-555555555555";
const email="david@example.test";
const transport={api_version:"v2",connection_ref:null,canonical_account_id:null,provider_namespace:"unipile:v2:app_lifty",account_id:null,
  application_id:"app_lifty",account_scope_id:null,user_id:null,owner_profile_id:null,v1_account_id:null,generation:0,hosted_auth_origin:"https://auth.lifty.test"};
function fixture() {
  let row:Record<string,unknown>={intent_ref:intent,workspace_ref:workspace,workspace_slug:"lift",sender_ref:sender,issuer_user_id:user,email,
    state:"pending",expires_at:new Date(Date.now()+3600000).toISOString(),connection_ref:null,account_id:null,transport:{...transport},hosted_url:null,
    authorization_received:false,authorization_account_id:null,return_error:null,campaign_send_paused:null,connection_status:null};
  const calls:{operation:string;payload:Record<string,unknown>}[]=[],network:{url:string;body:Record<string,unknown>|null}[]=[];
  let rpcFailure:string|null=null,healthy=true,providerEmail=email,revokedAfterRead=false;
  let healthResponse:"connected"|"disconnected"|null=null;
  async function rpc(_name:string,args:Record<string,unknown>){
    const op=String(args.p_operation),payload=args.p_payload as Record<string,unknown>;calls.push({operation:op,payload});
    if(rpcFailure)return {data:null,error:{message:rpcFailure,code:"PT403"}};
    if(op==="start" && payload.allow_v2!==true)return {data:null,error:{message:"client_update_required",code:"PT409"}};
    if(op==="issue_link"){if(row.state!=="pending")return {data:{claimed:false},error:null};row.state="issuing";return {data:{claimed:true},error:null};}
    if(op==="save_link"){row.hosted_url=payload.url;row.state="ready";}
    if(op==="return_error")row.return_error=payload.return_error;
    if(op==="health" && healthResponse)row={...row,connection_status:healthResponse,campaign_send_paused:true};
    if(op==="complete"){
      row={...row,state:"completed",connection_ref:connection,account_id:"acc_native",campaign_send_paused:true,connection_status:"connected",
        transport:{...transport,connection_ref:connection,canonical_account_id:"acc_native",account_id:"acc_native",user_id:"native-owner",generation:1}};
    }
    return {data:structuredClone(row),error:null};
  }
  const session={userId:user,client:{rpc}};
  const ops=createClientEmailOperations({serverKey:"server-key-12345678901234567890123456789",publicBaseUrl:"https://api.lifty.test",
    supabaseUrl:"https://db.test",publishableKey:"public",dsn:"https://api1.unipile.com",accessToken:"v1-test-key",
    v2:{accessToken:"v2-test-key",applicationId:"app_lifty",hostedAuthOrigins:["https://auth.lifty.test"]},
    fetchImpl:async(input,init)=>{
      const url=String(input),body=init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : null;
      network.push({url,body});
      if(url==="https://db.test/rest/v1/rpc/lifty_client_email_connection"){
        const result=await rpc("",body!);return Response.json(result.error ?? result.data,{status:result.error ? 403 : 200});
      }
      expect(new Headers(init?.headers).get("x-api-key")).toBe("v2-test-key");
      if(url==="https://api.unipile.com/v2/auth/link")return Response.json({object:"HostedAuthLink",link:"https://auth.lifty.test/session"});
      if(url==="https://api.unipile.com/v2/accounts/acc_native")return Response.json({object:"Account",id:"acc_native",application_id:"app_lifty",user_id:"native-owner",
        provider:"google",status:healthy ? "running" : "disconnected",is_locked:false,metadata:{products_connection_status:{gmail:healthy ? "running" : "disconnected"}}});
      if(url==="https://api.unipile.com/v2/acc_native/email-senders"){
        if(revokedAfterRead)rpcFailure="email_workspace_forbidden";
        return Response.json({data:[{object:"EmailSender",email:providerEmail,is_primary:true,verification_status:"verified"}],total_count:1});
      }
      throw Error(`Unexpected network boundary: ${url}`);
    }});
  return {ops,session,calls,network,row:()=>row,setRow:(change:Record<string,unknown>)=>{row={...row,...change};},
    healthResponse:(status:"connected"|"disconnected")=>{healthResponse=status;},
    revoke:()=>{rpcFailure="email_workspace_forbidden";},unhealthy:()=>{healthy=false;},mismatch:()=>{providerEmail="other@example.test";},revokeDuringRead:()=>{revokedAfterRead=true;}};
}
const start=(h:ReturnType<typeof fixture>)=>h.ops.connect(h.session,{workspace:"lift",sender_ref:sender,email,protocol_version:2});
it("issues a Lifty URL for the selected existing client sender without creating a provider account",async()=>{
  const h=fixture(),result=await start(h);
  expect(new URL(result.connection_url).origin).toBe("https://api.lifty.test");
  expect(new URL(result.connection_url).pathname).toBe("/unipile/client-email/start");
  expect(result).toMatchObject({email,sender_ref:sender,status:"link_issued"});
  expect(h.calls).toEqual([{operation:"start",payload:{workspace:"lift",sender_ref:sender,email,allow_v2:true}}]);
  expect(h.network).toEqual([]);
});
it("old clients get an explicit update requirement before provider authorization",async()=>{
  const h=fixture();
  await expect(h.ops.connect(h.session,{workspace:"lift",sender_ref:sender,email})).rejects.toMatchObject({code:"CLIENT_UPDATE_REQUIRED"});
  expect(h.network).toEqual([]);
});
it("creates only a branded V2 Google link and retains its signed authorization correlation",async()=>{
  const h=fixture(),link=await start(h);
  expect(await h.ops.authorize(link.attempt_ref)).toBe("https://auth.lifty.test/session");
  const request=h.network.find(x=>x.url.endsWith("/auth/link"))!.body!;
  expect(request).toMatchObject({providers:["google"],domain:"auth.lifty.test",redirect_uri:`https://api.lifty.test/unipile/v2/client-email/return?intent=${link.attempt_ref}`});
  expect(request.account_id).toBeUndefined();expect(request.state).toMatch(/^lifty\.v2\.client-email\./);
  expect(h.calls.find(x=>x.operation==="auth_state")!.payload.state).toBe(request.state);
  expect(await h.ops.authorize(link.attempt_ref)).toBe("https://auth.lifty.test/session");
  expect(h.network.filter(x=>x.url.endsWith("/auth/link"))).toHaveLength(1);
});
it("a browser return cannot connect without the signed provider authorization",async()=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);
  const app=createApp({receiveClientEmailV2Return:h.ops.v2Return,log:()=>{}});
  const response=await app.request(`https://api.lifty.test/unipile/v2/client-email/return?intent=${link.attempt_ref}&check=1&account_id=acc_native&provider=google`);
  expect(response.status).toBe(200);expect(h.calls.some(x=>x.operation==="complete")).toBe(false);
  expect(h.network.some(x=>x.url.includes("/v2/accounts/"))).toBe(false);
});
it("signed authorization and authenticated exact-mailbox read bind; durable status reads again after link expiry",async()=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);
  h.setRow({authorization_received:true,authorization_account_id:"acc_native"});
  expect(await h.ops.status(h.session,{workspace:"lift",attempt_ref:link.attempt_ref})).toMatchObject({status:"connected",connection_ref:connection,campaign_send_paused:true});
  expect(h.calls.find(x=>x.operation==="complete")!.payload).toMatchObject({account_id:"acc_native",email,verified_transport:{api_version:"v2",v1_account_id:null}});
  h.setRow({expires_at:new Date(Date.now()-65*60000).toISOString()});h.network.length=0;
  expect(await h.ops.status(h.session,{workspace:"lift",connection_ref:connection})).toMatchObject({status:"connected",connection_ref:connection});
  expect(h.network.map(x=>x.url)).toEqual(["https://api.unipile.com/v2/accounts/acc_native","https://api.unipile.com/v2/acc_native/email-senders"]);
  h.unhealthy();expect(await h.ops.status(h.session,{workspace:"lift",connection_ref:connection})).toMatchObject({status:"needs_reconnect"});
});
it("mailbox mismatch never completes, even after a signed authorization",async()=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);h.setRow({authorization_received:true,authorization_account_id:"acc_native"});h.mismatch();
  await expect(h.ops.status(h.session,{workspace:"lift",attempt_ref:link.attempt_ref})).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
  expect(h.calls.some(x=>x.operation==="complete")).toBe(false);
});
it.each(["connected","disconnected"] as const)("durable status sends fresh mailbox proof and honors the server's %s recovery decision",async(status)=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);
  h.setRow({authorization_received:true,authorization_account_id:"acc_native"});
  await h.ops.status(h.session,{workspace:"lift",attempt_ref:link.attempt_ref});
  h.setRow({connection_status:"disconnected"});h.healthResponse(status);h.calls.length=0;
  expect(await h.ops.status(h.session,{workspace:"lift",connection_ref:connection})).toMatchObject({status:status==="connected" ? "connected" : "needs_reconnect",campaign_send_paused:true});
  expect(h.calls.find(x=>x.operation==="health")?.payload).toMatchObject({workspace:"lift",connection_ref:connection,email,status:"running",
    transport_generation:1,verified_transport:{api_version:"v2",application_id:"app_lifty",account_id:"acc_native",user_id:"native-owner",v1_account_id:null}});
  expect(h.calls.map(x=>x.operation)).toEqual(["status","status","health"]);
});
it("a foreign provider mailbox never reaches health reconciliation",async()=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);
  h.setRow({authorization_received:true,authorization_account_id:"acc_native"});await h.ops.status(h.session,{workspace:"lift",attempt_ref:link.attempt_ref});
  h.mismatch();h.calls.length=0;
  expect(await h.ops.status(h.session,{workspace:"lift",connection_ref:connection})).toMatchObject({status:"needs_reconnect"});
  expect(h.calls.some(x=>x.operation==="health")).toBe(false);
});
it("issuer, membership and route authority are checked again before returning a provider-backed status",async()=>{
  const h=fixture(),link=await start(h);
  await expect(h.ops.status({...h.session,userId:sender},{workspace:"lift",attempt_ref:link.attempt_ref})).rejects.toMatchObject({code:"EMAIL_WORKSPACE_FORBIDDEN"});
  await h.ops.authorize(link.attempt_ref);h.setRow({authorization_received:true,authorization_account_id:"acc_native"});
  await h.ops.status(h.session,{workspace:"lift",attempt_ref:link.attempt_ref});h.revokeDuringRead();
  await expect(h.ops.status(h.session,{workspace:"lift",connection_ref:connection})).rejects.toMatchObject({code:"EMAIL_WORKSPACE_FORBIDDEN"});
});
it("native token tampering is rejected before any provider or database request",async()=>{
  const h=fixture(),link=await start(h);const count=h.calls.length;
  const claims=JSON.parse(Buffer.from(link.attempt_ref.split(".")[0]!,"base64url").toString());claims.sender_id=user;
  const forged=`${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${link.attempt_ref.split(".")[1]}`;
  await expect(h.ops.authorize(forged)).rejects.toMatchObject({code:"EMAIL_INTENT_EXPIRED"});
  expect(h.calls).toHaveLength(count);expect(h.network).toEqual([]);
});
it("cancel hints explain the return while later signed authorization still wins",async()=>{
  const h=fixture(),link=await start(h);await h.ops.authorize(link.attempt_ref);
  expect(await h.ops.v2Return(link.attempt_ref,"authorization_cancelled")).toMatchObject({status:"failed"});
  h.setRow({authorization_received:true,authorization_account_id:"acc_native"});
  expect(await h.ops.v2Return(link.attempt_ref)).toEqual({status:"connected",account:email});
});
it("the public start route rejects a V1 or foreign handoff",async()=>{
  for(const target of ["https://account.unipile.com/session","https://evil.test/session"]){
    const app=createApp({authorizeClientEmail:async()=>target,unipileV2HostedAuthOrigins:["https://auth.lifty.test"],log:()=>{}});
    expect((await app.request("https://api.lifty.test/unipile/client-email/start?intent=test")).status).toBe(502);
  }
});
