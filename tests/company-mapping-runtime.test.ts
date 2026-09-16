import { expect, it, vi } from "vitest";
import { createCompanyMapping } from "../src/company-mapping.js";
import { createCompanyReadinessCheck } from "../src/company-mapping/readiness.js";
import { createApp } from "../src/app.js";
import { COMPANY_OPERATION_TIMEOUT_MS } from "../src/company-mapping/runtime.js";
import type { Property, Mapping } from "../src/company-mapping/contract.js";
import { HUBSPOT_OAUTH_SCOPES } from "../src/generated/hubspot-grant-policy.js";
const ws="85800000-0000-4000-a000-000000000001", integration="85800000-0000-4000-a000-000000000002";
const key="capability-key-which-is-not-a-supabase-admin-key";
function fixture() {
 const state={workspace_ref:ws,workspace_name:"Fixture",integration_ref:integration,portal_id:"123",mapping_version:"a".repeat(64),mappings:[] as Mapping[]};
 const properties:Property[]=[{name:"name",label:"Name",type:"string",fieldType:"text"},{name:"domain",label:"Domain",type:"string",fieldType:"text"},{name:"type",label:"Type",type:"enumeration",fieldType:"select",options:[{label:"Prospect",value:"PROSPECT"}]}];
 const grant={access_token:"scoped-access",client_id:"client",client_secret:"fixture-only",refresh_token:"refresh",obtained_at_epoch:Math.floor(Date.now()/1000),expires_at_epoch:Math.floor(Date.now()/1000)+3600,portal_id:"123",scopes:[...HUBSPOT_OAUTH_SCOPES]};
 const secret=()=>JSON.stringify(grant);
 const rpc=vi.fn(async (_name:string,args:Record<string,any>)=>{
  expect(_name).toBe("lifty_crm_company_tools"); expect(args.p_server_key).toBe(key);
  const p=args.p_payload;
  if(args.p_operation==="state") return {data:structuredClone(state),error:null};
  expect(p).toMatchObject({workspace_ref:ws,integration_ref:integration,portal_id:"123"});
  if(args.p_operation==="credential") return {data:{secret:secret(),credential_version:"c".repeat(64),workspace_ref:ws,integration_ref:integration,portal_id:"123"},error:null};
  if(args.p_operation==="rotate") return {data:{status:"rotated"},error:null};
  if(args.p_operation==="publish") {state.mappings=p.rows;state.mapping_version="b".repeat(64);return {data:{status:"ready"},error:null};}
  return {data:null,error:{message:"unexpected-operation"}};
 });
 const writes:string[]=[];
 const provider=vi.fn<typeof fetch>(async (url,init)=>{
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scoped-access");
  if(String(url).includes("account-info")) return Response.json({portalId:123});
  expect(String(url)).toMatch(/^https:\/\/api.hubapi.com\/crm\/v3\/properties\/companies/);
  if(init?.method==="POST") {const value=JSON.parse(String(init.body));properties.push(value);writes.push(`create:${value.name}`);}
  if(init?.method==="PATCH") {const name=String(url).split("/").at(-1);const property=properties.find(p=>p.name===name)!;Object.assign(property,JSON.parse(String(init.body)));writes.push(`options:${name}`);}
  return Response.json({results:properties});
 });
 const session={userId:ws,client:{rpc}};
 const run=createCompanyMapping({serverKey:key,fetch:provider});
 const plan=async()=>{
  const context=await run(session,"context",undefined,{workspaceRef:ws});
  if(!("schema_version" in context)) throw new Error("Expected context");
  return {version:1,workspace_ref:ws,portal_id:"123",mapping_version:context.mapping_version,schema_version:context.schema_version,type_values:{top_target:"Top Target",prospect:"PROSPECT"},tier_values:{A:"A",B:"B",C:"C","Non-ICP":"Non-ICP"},allow_schema_changes:true};
 };
 return {session,run,rpc,provider,state,properties,grant,plan,writes};
}
it("native API workflow uses scoped user RPCs and provider readback; exact retry writes nothing",async()=>{
 const f=fixture(),plan=await f.plan();
 const receipt=await f.run(f.session,"apply",plan);
 expect(receipt).toMatchObject({verified:true,mapping_count:5});expect(f.writes).toHaveLength(3);
 const before=f.writes.length;await f.run(f.session,"apply",plan);expect(f.writes).toHaveLength(before);
 expect(f.rpc.mock.calls.filter(([,a])=>a.p_operation==="publish")).toHaveLength(1);
 expect(JSON.stringify(receipt)).not.toMatch(/scoped-access|fixture-only|capability-key/);
});
it.each(["lifty_company_mapping_forbidden","lifty_workspace_ambiguous","lifty_crm_service_forbidden"])("denied storage %s prevents every provider request",async message=>{
 const f=fixture();f.rpc.mockResolvedValue({data:null,error:{message}});
 await expect(f.run(f.session,"context")).rejects.toMatchObject({code:message.includes("forbidden")?(message.includes("service")?"COMPANY_MAPPING_NOT_CONFIGURED":"FORBIDDEN_WORKSPACE"):"WORKSPACE_AMBIGUOUS"});expect(f.provider).not.toHaveBeenCalled();
});
it("wrong provider portal fails before schema mutation and does not publish",async()=>{
 const f=fixture();f.provider.mockResolvedValue(Response.json({portalId:999}));
 await expect(f.run(f.session,"context")).rejects.toMatchObject({code:"WORKSPACE_OR_PORTAL_CHANGED"});expect(f.writes).toEqual([]);expect(f.rpc.mock.calls.some(([,a])=>a.p_operation==="publish")).toBe(false);
});
it("credential scope mismatch is rejected before token use",async()=>{
 const f=fixture(),original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation(async(name,args)=>args.p_operation==="credential"?{data:{secret:"private-token",credential_version:"c".repeat(64),workspace_ref:integration,integration_ref:integration,portal_id:"123"},error:null}:original(name,args));
 await expect(f.run(f.session,"context")).rejects.toMatchObject({code:"WORKSPACE_OR_PORTAL_CHANGED"});expect(f.provider).not.toHaveBeenCalled();
});
it("refresh persists through a credential-version CAS and portal-scoped capability",async()=>{
 const f=fixture();f.grant.obtained_at_epoch=1;f.grant.expires_at_epoch=2;
 const original=f.provider.getMockImplementation()!;
 f.provider.mockImplementation(async(url,init)=>String(url).includes("/oauth/2026-03/token")?Response.json({access_token:"scoped-access",refresh_token:"rotated",expires_in:1800,scope:HUBSPOT_OAUTH_SCOPES.join(" "),hub_id:"123"}):original(url,init));
 await f.run(f.session,"context",undefined,{workspaceRef:ws});
 expect(f.rpc.mock.calls.find(([,a])=>a.p_operation==="rotate")?.[1].p_payload).toMatchObject({workspace_ref:ws,integration_ref:integration,portal_id:"123",credential_version:"c".repeat(64),grant:{refresh_token:"rotated"}});
});
it("operation deadline aborts provider work and prevents late publication",async()=>{
 const f=fixture(),plan=await f.plan();let finish:(r:Response)=>void=()=>{};
 f.provider.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const run=createCompanyMapping({serverKey:key,fetch:f.provider,operationTimeoutMs:10});
 await expect(run(f.session,"apply",plan)).rejects.toMatchObject({code:"COMPANY_MAPPING_TIMEOUT",status:504});
 expect(f.provider.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
 finish(Response.json({portalId:123}));await new Promise(resolve=>setTimeout(resolve,10));
 expect(f.writes).toEqual([]);expect(f.rpc.mock.calls.some(([,a])=>a.p_operation==="publish")).toBe(false);
 expect(COMPANY_OPERATION_TIMEOUT_MS).toBeGreaterThan(10_000);
});
it("a cancelled caller starts neither storage nor provider calls",async()=>{
 const f=fixture();await expect(f.run(f.session,"context",undefined,{signal:AbortSignal.abort()})).rejects.toMatchObject({code:"COMPANY_MAPPING_TIMEOUT"});expect(f.rpc).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
});
it("unknown storage/provider failures return a finite error with no secrets",async()=>{
 const f=fixture();f.rpc.mockRejectedValue(new Error("credential: private-fixture-token"));
 await expect(f.run(f.session,"context")).rejects.toMatchObject({code:"COMPANY_MAPPING_UNAVAILABLE"});
});
it("deployment readiness checks the actual versioned CRM capability without tenant or provider access",async()=>{
 const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ready:true,version:"lifty-crm-company.v1"}));
 const config={supabaseUrl:"https://db.test",publishableKey:"public",jwks:new URL("https://db.test/jwks")};
 expect(await createCompanyReadinessCheck(config,{serverKey:key,fetch:fetcher})()).toBe(true);
 expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({p_server_key:key,p_operation:"capabilities",p_payload:{}});
 expect(await createCompanyReadinessCheck(config,null)()).toBe(false);
 fetcher.mockResolvedValue(Response.json({ready:true,version:"old"}));expect(await createCompanyReadinessCheck(config,{serverKey:key,fetch:fetcher})()).toBe(false);
 const app=createApp({checkCompanyReadiness:async()=>false});expect((await app.request("/readyz/crm")).status).toBe(503);
 expect(await (await createApp({checkCompanyReadiness:async()=>true}).request("/readyz/crm")).json()).toEqual({status:"ready",capability:"lifty-crm-company.v1"});
});

it("maintenance freeze rejects apply before any provider or storage side effect; context remains readable",async()=>{
 const f=fixture();const run=createCompanyMapping({serverKey:key,fetch:f.provider,readOnly:true});
 await expect(run(f.session,"apply",{})).rejects.toMatchObject({code:"MAINTENANCE_READ_ONLY",status:503});
 expect(f.rpc).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
 expect(await run(f.session,"context")).toMatchObject({status:"action_needed"});
});

it("UUID workspace selection accepts equivalent uppercase text", async()=>{
 const f=fixture();f.state.workspace_ref="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation(async(name,args)=>args.p_operation==="credential"?{data:{secret:JSON.stringify(f.grant),credential_version:"c".repeat(64),workspace_ref:f.state.workspace_ref,integration_ref:integration,portal_id:"123"},error:null}:original(name,args));
 expect(await f.run(f.session,"context",undefined,{workspaceRef:f.state.workspace_ref.toUpperCase()})).toMatchObject({workspace_ref:f.state.workspace_ref});
 expect(f.rpc.mock.calls[0]?.[1].p_payload.workspace_ref).toBe(f.state.workspace_ref);
});
