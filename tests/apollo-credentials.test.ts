import {describe,it,expect,vi} from "vitest";
import {createApp} from "../src/app.js";
import {apolloCredentials} from "../src/apollo-credentials.js";
const workspace="22222222-2222-4222-8222-222222222222",user="11111111-1111-4111-8111-111111111111";
const path=`/v1/workspaces/${workspace}/integrations/apollo/key-source`;
const key="test-own-key-only";
const receipt={workspace_ref:workspace,tool:"apollo",key_source:"own_key",configured:true,changed:true};
const post=(body:unknown)=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
function harness(data:unknown=receipt,error:unknown=null){
 const rpc=vi.fn(async()=>({data,error}));const log=vi.fn();
 const app=createApp({authenticate:async()=>({ok:true,session:{userId:user,client:{rpc}}}),apolloCredentials,log});return {app,rpc,log};
}
describe("Apollo credential API boundary",()=>{
 it("requires login before receiving a credential",async()=>{
  const operation=vi.fn();const app=createApp({apolloCredentials:operation});expect((await app.request(path,post({operation:"own_key",api_key:key}))).status).toBe(401);expect(operation).not.toHaveBeenCalled();
 });
 it("uses caller JWT and exact workspace; returns no key and logs no body",async()=>{
  const h=harness();const response=await h.app.request(path,post({operation:"own_key",api_key:key}));expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(h.rpc).toHaveBeenCalledWith("lifty_apollo_credentials",{p_workspace_id:workspace,p_operation:"own_key",p_api_key:key});expect(JSON.stringify(h.log.mock.calls)).not.toContain(key);
 });
 it("status and platform choice never carry key material",async()=>{
  const h=harness({...receipt,key_source:"platform_default",changed:false});expect((await h.app.request(path)).status).toBe(200);expect(h.rpc).toHaveBeenLastCalledWith("lifty_apollo_credentials",{p_workspace_id:workspace,p_operation:"status",p_api_key:null});
  expect((await h.app.request(path,post({operation:"platform_default"}))).status).toBe(200);expect(h.rpc).toHaveBeenLastCalledWith("lifty_apollo_credentials",{p_workspace_id:workspace,p_operation:"platform_default",p_api_key:null});
 });
 it("rejects unsupported tool, foreign ID override, empty/whitespace keys and extraneous secrets",async()=>{
  const h=harness();for(const body of [{operation:"unipile",api_key:key},{operation:"own_key"},{operation:"own_key",api_key:" "},{operation:"own_key",api_key:"a\nb"},{operation:"own_key",api_key:key,workspace_ref:user},{operation:"platform_default",api_key:key},{operation:"status",secret:key}])expect((await h.app.request(path,post(body))).status).toBe(400);expect(h.rpc).not.toHaveBeenCalled();
 });
 it.each(["workspace_forbidden","workspace_not_lifty","workspace_suspended","apollo_execution_in_progress","apollo_platform_unavailable","apollo_platform_key_requires_default"])("preserves guard %s with safe errors",async message=>{
  const h=harness(null,{code:"PT409",message,details:key});const response=await h.app.request(path,post({operation:"own_key",api_key:key}));expect(response.status).toBe(409);expect(await response.text()).not.toContain(key);expect(h.rpc).toHaveBeenCalledTimes(1);
 });
 it("rejects configured status with no source",async()=>{expect((await harness({...receipt,key_source:null}).app.request(path)).status).toBe(502);});
 it("fails closed on foreign receipt, unexpected secret fields and unknown errors",async()=>{
  for(const data of [{...receipt,workspace_ref:user},{...receipt,api_key:key},{...receipt,key_source:"platform_default"},{...receipt,configured:false}])expect((await harness(data).app.request(path,post({operation:"own_key",api_key:key}))).status).toBe(502);
  const h=harness(null,{code:"XX000",message:key});const response=await h.app.request(path,post({operation:"own_key",api_key:key}));expect(response.status).toBe(502);expect(await response.text()).not.toContain(key);expect(h.rpc).toHaveBeenCalledTimes(1);
 });
 it("rejects oversize requests before the RPC",async()=>{const h=harness();expect((await h.app.request(path,post({operation:"own_key",api_key:"a".repeat(9000)}))).status).toBe(413);expect(h.rpc).not.toHaveBeenCalled();});
});
