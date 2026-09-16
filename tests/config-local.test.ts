import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { getConfigUpdateContext, submitConfigUpdate } from "../src/workspace-operations.js";
import { localConfiguration } from "./onboarding-fixtures.js";
import { type ConfigUpdateContext, type ConfigUpdateRequest, type ConfigUpdateSubmission } from "../src/contracts.js";

const version=`sha256:${"a".repeat(64)}`;
const current: ConfigUpdateContext = {
  contract_version:"lifty-config-update.v1",context_version:version,scout_global_base:"GLOBAL BASE",onboarding_draft:{personas:localConfiguration.icp_config.personas},
  current_config:{workspace_ref:"workspace",config:{icp:{...localConfiguration.icp_config,version:1,digest:version,contact_email_status:"verified",q_organization_domains_list:null,q_keywords:null,max_stale_days:90,reject_extrapolated:true},tone:{version,values:{}},prompt:{version,digest:version,text:localConfiguration.scout_overlay,source:"lif656_onboarding_import"},workspace:{version,name:"Example",description:null,daily_discovery_target:10}}},
};
const configuration={contract_version:"lifty-config-update.v1",context_version:version,personas:null,scout_overlay:localConfiguration.scout_overlay};
const receipt: ConfigUpdateSubmission={state:"queued",submission_ref:"submission",run_ref:"submission",import_status:"pending",changed_sections:["tone"],artifact_actions:{prompt:"regenerate"},regenerate_icp:false,regenerate_prompt:true,workspace_ref:"workspace",created:true};
const authenticate=async()=>({ok:true as const,session:{userId:"founder",client:{}}});
const patch=(app:ReturnType<typeof createApp>,body:unknown)=>app.request("/v1/config",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
it("requires authentication for current config generation context",async()=>{expect((await createApp().request("/v1/config/context")).status).toBe(401);});
it("returns private no-store generation context and canonical schema",async()=>{
 const response=await createApp({authenticate,getConfigUpdateContext:async()=>current}).request("/v1/config/context");
 expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
 const body=await response.json();expect(body.configuration_schema.properties.contract_version.const).toBe("lifty-config-update.v1");expect(body.generation_rules).toContain("never calls a hosted model");expect(body.current_config).toEqual(current.current_config);
});
it("submits the exact local update and enqueues deterministic import",async()=>{
 const submit=vi.fn(async(_session: unknown, _body: ConfigUpdateRequest)=>receipt);const enqueue=vi.fn(async()=>({id:"run"}));
 const body={section:"tone",values:{identity:"Concise"},configuration};
 const response=await patch(createApp({authenticate,getConfigUpdateContext:async()=>current,submitConfigUpdate:submit,enqueueConfigUpdate:enqueue}),body);
 expect(response.status).toBe(200);expect(submit.mock.calls[0]?.[1]).toEqual(body);expect(enqueue).toHaveBeenCalledOnce();
});
it.each([
 {...configuration,context_version:"stale"},
 {...configuration,scout_overlay:"PRIVATE_INVALID_CANDIDATE"},
 {...configuration,scout_overlay:configuration.scout_overlay+"GLOBAL BASE"},
 {...configuration,personas:[{name:"invented",titles:["CEO"]}]},
])("rejects invalid update with bounded non-echoing diagnostics",async artifact=>{
 const submit=vi.fn();const enqueue=vi.fn();
 const response=await patch(createApp({authenticate,getConfigUpdateContext:async()=>current,submitConfigUpdate:submit,enqueueConfigUpdate:enqueue}),{section:"tone",values:{identity:"Brief"},configuration:artifact});
 expect(response.status).toBe(422);const text=await response.text();expect(JSON.parse(text).error.issues.length).toBeGreaterThan(0);expect(text).not.toContain("PRIVATE_INVALID_CANDIDATE");expect(submit).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
});
it("does not demand generation context or an artifact for simple workspace metadata",async()=>{
 const getContext=vi.fn();const submit=vi.fn(async()=>({...receipt,state:"applied" as const,import_status:"imported" as const,regenerate_prompt:false,changed_sections:["workspace" as const],artifact_actions:{workspace:"applied"}}));
 const response=await patch(createApp({authenticate,getConfigUpdateContext:getContext,submitConfigUpdate:submit}),{section:"workspace",values:{name:"New name"}});
 expect(response.status).toBe(200);expect(getContext).not.toHaveBeenCalled();
});
it.each([
 ["lifty_config_local_required","PT400",422,"LOCAL_CONFIGURATION_REQUIRED"],
 ["lifty_config_context_stale","PT409",409,"CONFIG_CONTEXT_STALE"],
 ["lifty_config_local_mismatch","PT409",409,"LOCAL_CONFIGURATION_MISMATCH"],
])("keeps SQL authorization/CAS diagnostics explicit: %s",async(message,code,status,expected)=>{
 const session={userId:"founder",client:{rpc:async()=>({data:null,error:{message,code}})}};
 await expect(submitConfigUpdate(session,{section:"tone",values:{identity:"Brief"}})).rejects.toMatchObject({status,code:expected});
});
it("fetches context through the authenticated RPC without an actor override",async()=>{
 const rpc=vi.fn(async()=>({data:current,error:null}));expect(await getConfigUpdateContext({userId:"founder",client:{rpc}})).toEqual(current);expect(rpc).toHaveBeenCalledWith("get_lifty_config_update_context");
});
it("legacy clients receive an explicit upgrade diagnosis instead of hosted-update instructions",async()=>{
 const app=createApp();for(const version of ["v1","v2"]) {const r=await app.request(`/v1/context/workspace?client_contract=lifty-cli-context.${version}`);expect(r.status).toBe(200);expect((await r.json()).instructions).toContain("Hosted generation is no longer available");}
 const r=await app.request("/v1/context/workspace?client_contract=lifty-cli-context.v3");expect((await r.json()).instructions).toContain("config-context");
});

it("persona repairs use the artifact's actual JSON pointer", async()=>{
 const r=await patch(createApp({authenticate,getConfigUpdateContext:async()=>current}),{section:"icp",values:{personas:localConfiguration.icp_config.personas},configuration:{...configuration,personas:[{name:"invented",titles:["CEO"]}]}});
 const body=await r.json();expect(body.error.issues.some((issue:{path:string})=>issue.path==="/configuration/personas")).toBe(true);
});

it("leaves stale-versus-imported replay decisions to SQL without reinterpreting an old artifact",async()=>{
 const changed={...current,context_version:`sha256:${"b".repeat(64)}`,scout_global_base:configuration.scout_overlay};
 const submit=vi.fn(async()=>({...receipt,state:"applied" as const,import_status:"imported" as const,created:false}));
 const r=await patch(createApp({authenticate,getConfigUpdateContext:async()=>changed,submitConfigUpdate:submit}),{section:"tone",values:{identity:"Concise"},configuration});
 expect(r.status).toBe(200);expect(submit).toHaveBeenCalledOnce();
});

it.each([{personas:[null]},{personas:[17]},{personas:null},{personas:[]}])("malformed desired personas return bounded diagnostics without throwing (%s)",async ({personas})=>{
 const submit=vi.fn();const r=await patch(createApp({authenticate,getConfigUpdateContext:async()=>current,submitConfigUpdate:submit}),{values:{icp:{personas}},configuration});
 expect(r.status).toBe(422);expect((await r.json()).error.issues).toContainEqual(expect.objectContaining({code:"desired_personas_invalid",path:"/values/icp/personas"}));expect(submit).not.toHaveBeenCalled();
});
