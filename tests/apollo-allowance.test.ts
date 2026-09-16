import {describe,it,expect,vi} from "vitest";
import {createApp} from "../src/app.js";
import {getApolloAllowance} from "../src/apollo-allowance.js";
const workspace="68000000-0000-4000-8000-000000000001",other="68000000-0000-4000-8000-000000000002";
const status={workspace_ref:workspace,lifty:true,applies:true,key_source:"platform_default",limit:25,used:5,reserved:3,remaining:17,resets_at:"2026-09-21T00:00:00+00:00"};
const path=`/v1/workspaces/${workspace}/apollo/allowance`;
function app(data:unknown=status,error:unknown=null){const rpc=vi.fn(async()=>({data,error}));return {rpc,app:createApp({authenticate:async()=>({ok:true,session:{userId:other,client:{rpc}}}),getApolloAllowance,log:()=>{}})};}
describe('Apollo weekly allowance HTTP boundary',()=>{
 it('requires login before reading',async()=>{const getter=vi.fn();expect((await createApp({getApolloAllowance:getter}).request(path)).status).toBe(401);expect(getter).not.toHaveBeenCalled();});
 it('reads caller-scoped status without privileged keys or write operations',async()=>{const h=app({...status,key_secret_id:'private'});const r=await h.app.request(path);expect(r.status).toBe(200);expect(await r.json()).toEqual(status);expect(r.headers.get('cache-control')).toBe('no-store');expect(h.rpc).toHaveBeenCalledWith('get_lifty_apollo_allowance',{p_workspace_id:workspace});});
 it('rejects invalid path without RPC',async()=>{const h=app();expect((await h.app.request('/v1/workspaces/invalid/apollo/allowance')).status).toBe(400);expect(h.rpc).not.toHaveBeenCalled();});
 it('preserves membership denial and redacts internal errors',async()=>{const h=app(null,{message:'lifty_workspace_forbidden',details:'private-key'});const r=await h.app.request(path);expect(r.status).toBe(403);expect(await r.text()).not.toContain('private-key');});
 it('rejects cross-tenant and inconsistent results',async()=>{for(const data of [{...status,workspace_ref:other},{...status,limit:26},{...status,remaining:30}])expect((await app(data).app.request(path)).status).toBe(502);});
 it('unconfigured remains explicit without invented allowance',async()=>{const data={...status,applies:false,key_source:'unconfigured',limit:null,remaining:null};expect(await (await app(data).app.request(path)).json()).toEqual(data);});
 it('customer-owned is explicitly outside the configured allowance',async()=>{const data={...status,applies:false,key_source:'own_key',limit:null,remaining:null};expect(await (await app(data).app.request(path)).json()).toEqual(data);});
});

it('accepts an audited weekly bonus without changing consumed or reserved counts',async()=>{const data={...status,limit:100,used:25,reserved:0,remaining:75};const r=await app(data).app.request(path);expect(r.status).toBe(200);expect(await r.json()).toEqual(data);});
it('retains zero remaining for conservatively bootstrapped over-limit history',async()=>{const data={...status,used:26,reserved:0,remaining:0};expect((await app(data).app.request(path)).status).toBe(200);});
