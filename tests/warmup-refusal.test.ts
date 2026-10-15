import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createWarmupSetup, DEFAULT_WARMUP_POLICY } from "../src/warmup-setup.js";
import { createWarmupSetupRouter } from "../src/warmup-setup-routes.js";
import { blockingMessage } from "../src/email-warmup.js";

const state="a".repeat(43), browser="b".repeat(43);
const record={email:"founder@example.test",workspace_ref:"22222222-2222-4222-8222-222222222222",
  sender_ref:"33333333-3333-4333-8333-333333333333",expires_at:"2030-01-01T00:00:00Z",
  policy:DEFAULT_WARMUP_POLICY,first_name:"Ada",last_name:"Lovelace"};
const taken={success:false,code:"VALIDATION_ERROR",error:{email:["The email has already been taken."],token:"PRIVATE_PROVIDER_TEXT"}};
function harness(method:"google"|"microsoft", response:()=>Response|Promise<Response>, lostSave=false) {
  let dispatched=false,claimed=false,refusal:string|null=null,saves=0;
  const writes:{operation:string;payload:Record<string,unknown>}[]=[],logs:unknown[]=[];
  const provider=vi.fn(response);
  const rpc=async(operation:string,payload:Record<string,unknown>)=>{
    writes.push({operation,payload});
    if(operation==="claim"){if(claimed)throw Error();claimed=true;}
    if(operation==="dispatch"){if(dispatched)throw Error();dispatched=true;}
    if(operation==="refuse") {refusal=String(payload.code);if(lostSave&&++saves===1)throw Error();return {state:"refused",code:refusal};}
    const dispatch=operation==="microsoft_prepare"&&!dispatched;
    if(dispatch)dispatched=true;
    return {...record,method,state:refusal?"refused":dispatched?"dispatched":"claimed",dispatch};
  };
  const fetchImpl:typeof fetch=async(input)=>{
    if(String(input).endsWith("lifty_warmup_browser_receipt"))return Response.json(refusal?{status:"failed",reason:refusal}:{status:"pending"});
    if(String(input).includes("oauth2.googleapis.com"))return Response.json({access_token:"PRIVATE_ACCESS",refresh_token:"PRIVATE_REFRESH",
      id_token:"PRIVATE_ID",scope:"openid email https://mail.google.com/",token_type:"Bearer"});
    return provider();
  };
  const setup=createWarmupSetup({serverKey:"k".repeat(32),publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://db.test",
    publishableKey:"public",googleClientId:"google",googleClientSecret:"secret",mailivery:{apiKey:"private"}},
    {rpc,fetchImpl,verifyIdentity:async()=>({email:record.email,email_verified:true})});
  const app=new Hono().route("/warmup",createWarmupSetupRouter(setup,e=>logs.push(e)));
  const path=method==="google"?"google/callback":"microsoft/return";
  const request=async(stage="process")=>app.request(`https://api.lifty.test/warmup/${path}/${stage}`,{method:"POST",
    headers:{origin:"https://api.lifty.test","content-type":"application/json","x-lifty-connection":"1",cookie:`__Host-lifty-warmup-browser=${browser}`},
    body:JSON.stringify({state,...(stage==="process"&&method==="google"?{code:"PRIVATE_CODE"}:{})})});
  return {request,provider,writes,logs};
}
describe.each(["google","microsoft"] as const)("%s warmup refusal conformance",method=>{
  it.each([[400,taken,"mailbox_in_other_warmup"],[401,{success:false,error:"PRIVATE_KEY_ERROR"},"provider_rejected"],
    [403,{},"provider_rejected"],[429,{},"provider_rejected"]] as const)("persists only the mapped cause for HTTP %i and returns it during processing",async(status,body,code)=>{
    const h=harness(method,()=>Response.json(body,{status}),true);
    expect(await (await h.request()).json()).toEqual({status:"failed",reason:code});
    expect(await (await h.request("status")).json()).toEqual({status:"failed",reason:code});
    await h.request();
    expect(h.provider).toHaveBeenCalledTimes(1);
    const saves=h.writes.filter(x=>x.operation==="refuse");
    expect(saves).toHaveLength(2);expect(saves[0]).toEqual(saves[1]);
    expect(Object.keys(saves[0]!.payload).sort()).toEqual(["browser_hash","code","oauth_hash"]);
    expect(JSON.stringify([h.writes,h.logs])).not.toMatch(/PRIVATE|VALIDATION_ERROR|already been taken/);
    expect(blockingMessage(code)).toContain(code==="mailbox_in_other_warmup"?"Remove it there, then start warmup again in Lifty.":"Our team has been alerted.");
  });
  it.each([408,500,503,"timeout","lost"])("keeps %s uncertain without a refusal or second provider dispatch",async status=>{
    const h=harness(method,()=>{
      if(typeof status==="string")throw new Error("PRIVATE_TRANSPORT");
      const res=Response.json(taken,{status});
      res.body!.getReader=()=>{throw Error("must not read an uncertain body");};
      return res;
    });
    expect(await (await h.request()).json()).toEqual({status:"pending"});
    expect(await (await h.request()).json()).toEqual({status:"pending"});
    expect(h.provider).toHaveBeenCalledTimes(1);expect(h.writes.some(x=>x.operation==="refuse")).toBe(false);
  });
  it.each(["{broken",JSON.stringify(taken)+" ".repeat(16384)])("keeps oversized or malformed refusal bodies out of persistence",async body=>{
    const h=harness(method,()=>new Response(body,{status:400}));
    expect(await (await h.request()).json()).toEqual({status:"failed",reason:"provider_rejected"});
    expect(JSON.stringify(h.writes)).not.toContain("already been taken");
  });
  it("bounds a stalled refusal body and retains the definitive HTTP refusal",async()=>{
    vi.useFakeTimers();
    try {
      const h=harness(method,()=>new Response(new ReadableStream({start(){}}),{status:400}));
      const pending=h.request();await vi.advanceTimersByTimeAsync(2000);
      expect(await (await pending).json()).toEqual({status:"failed",reason:"provider_rejected"});
    } finally {vi.useRealTimers();}
  });
});
