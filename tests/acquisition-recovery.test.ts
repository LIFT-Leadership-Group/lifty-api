import {describe,it,expect,vi} from "vitest";
import {createCurrentClient as createApp} from "./current-client.js";
import {createAcquisitionRecoveryOperations} from "../src/acquisition-recovery.js";
import {createAcquisitionVerificationTrigger,createFirstRunTrigger} from "../src/trigger-client.js";
const workspace="22222222-2222-4222-8222-222222222222",run="11111111-1111-4111-8111-111111111111",next="33333333-3333-4333-8333-333333333333",recovery="44444444-4444-4444-8444-444444444444";
const path=`/v1/workspaces/${workspace}/apollo/recovery/${run}`;
const status={workspace_ref:workspace,first_run_ref:run,current_acquisition_ref:run,all_acquisition_refs:[run],attempt:0,can_restart:false,blocker:"terminal_proof_required",recovery_ref:recovery,recovery_state:"queued"};
const restart={workspace_ref:workspace,first_run_ref:run,previous_acquisition_ref:run,current_acquisition_ref:next,all_acquisition_refs:[run,next],attempt:1,state:"queued"};
const post=(operation="request",extra:Record<string,unknown>={})=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation,expected_acquisition_ref:run,...extra})});
function harness(data:unknown=status,error:unknown=null){
 const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data,error}));const verification=vi.fn(async()=>({id:"verifier"}));const first=vi.fn(async()=>({id:"parent"}));
 const app=createApp({authenticate:async()=>({ok:true,session:{userId:run,client:{rpc}}}),acquisitionRecovery:createAcquisitionRecoveryOperations({enqueueVerification:verification,enqueueFirstRun:first}),log:()=>{}});return {app,rpc,verification,first};
}
describe("explicit acquisition recovery",()=>{
 it("requires authentication and exact references before any mutation",async()=>{
  const operation=vi.fn();expect((await createApp({acquisitionRecovery:operation}).request(path,post())).status).toBe(401);expect(operation).not.toHaveBeenCalled();
  const h=harness();for(const extra of [{expected_acquisition_ref:null},{expected_acquisition_ref:"bad"},{workspace_ref:next},{force:true},{terminal_proof:true}])expect((await h.app.request(path,post("request",extra))).status).toBe(400);expect(h.rpc).not.toHaveBeenCalled();
 });
 it("status is one member-scoped read with no task wakeups",async()=>{
  const h=harness();const response=await h.app.request(path);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(h.rpc).toHaveBeenCalledWith("get_lifty_acquisition_status",{p_workspace_id:workspace,p_first_run_id:run});expect(h.first).not.toHaveBeenCalled();expect(h.verification).not.toHaveBeenCalled();
 });
 it("request binds workspace, run and acquisition before requesting only verification",async()=>{
  const h=harness();expect((await h.app.request(path,post())).status).toBe(200);expect(h.rpc).toHaveBeenCalledWith("request_lifty_acquisition_recovery",{p_workspace_id:workspace,p_first_run_id:run,p_expected_acquisition_ref:run});expect(h.verification).toHaveBeenCalledWith(recovery);expect(h.first).not.toHaveBeenCalled();
 });
 it("an already verified request never restarts or requeues verification",async()=>{
  const h=harness({...status,can_restart:true,blocker:null,recovery_state:"verified"});expect((await h.app.request(path,post())).status).toBe(200);expect(h.first).not.toHaveBeenCalled();expect(h.verification).not.toHaveBeenCalled();
 });
 it("explicit restart enqueues exactly the durable first-run attempt",async()=>{
  const h=harness(restart);expect((await h.app.request(path,post("restart"))).status).toBe(200);expect(h.rpc).toHaveBeenCalledWith("restart_lifty_acquisition",{p_workspace_id:workspace,p_first_run_id:run,p_expected_acquisition_ref:run});expect(h.first).toHaveBeenCalledWith(run,1);expect(h.verification).not.toHaveBeenCalled();
 });
 it("lost restart wakeup retries exact references/attempt without marking failure or creating a new run",async()=>{
  const h=harness(restart);h.first.mockRejectedValueOnce(new Error("private-trigger-credential"));const failed=await h.app.request(path,post("restart"));expect(failed.status).toBe(502);expect(await failed.text()).not.toContain("private-trigger-credential");expect((await h.app.request(path,post("restart"))).status).toBe(200);expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);expect(h.first.mock.calls).toEqual([[run,1],[run,1]]);expect(h.rpc.mock.calls.every(call=>call[0]==="restart_lifty_acquisition")).toBe(true);
 });
 it.each(["acquisition_forbidden","acquisition_parent_history_incomplete","acquisition_stale","acquisition_not_recoverable","acquisition_in_progress","recovery_restart_required"])("preserves guard %s without arbitrary SQL context",async message=>{
  const h=harness(null,{code:"PT409",message,details:"private"});const response=await h.app.request(path,post());expect(response.status).toBe(409);expect(await response.text()).not.toContain("private");expect(h.first).not.toHaveBeenCalled();expect(h.verification).not.toHaveBeenCalled();
 });
 it("foreign or impossible projections never enqueue work",async()=>{
  for(const data of [{...status,workspace_ref:next},{...status,first_run_ref:next},{...status,can_restart:true},{...status,all_acquisition_refs:[next]},{...status,api_key:"private"},{...status,blocker:"private-context"}]){const h=harness(data);expect((await h.app.request(path,post())).status).toBe(502);expect(h.first).not.toHaveBeenCalled();expect(h.verification).not.toHaveBeenCalled();}
  for(const data of [{...restart,previous_acquisition_ref:next},{...restart,current_acquisition_ref:run},{...restart,all_acquisition_refs:[next]}]){const h=harness(data);expect((await h.app.request(path,post("restart"))).status).toBe(502);expect(h.first).not.toHaveBeenCalled();}
 });
 it("verifier and parent wakeups use stable, separate identities and minimal payloads",async()=>{
  const fetchImpl=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({id:"task-run"}),{status:200}));const settings={apiUrl:"https://trigger.test",secretKey:"fixture-server-key",fetchImpl};
  const verify=createAcquisitionVerificationTrigger(settings);await verify(recovery);await verify(recovery);const first=createFirstRunTrigger(settings);await first(run,1);await first(run,1);
  const requests=fetchImpl.mock.calls.map(call=>JSON.parse(String(call[1]?.body)));
  expect(requests[0]).toEqual(requests[1]);expect(requests[0].payload).toEqual({recoveryRef:recovery});expect(requests[0].options.idempotencyKey).toBe(`lifty-discovery-reconcile:${recovery}`);expect(requests[2]).toEqual(requests[3]);expect(requests[2].options.idempotencyKey).toBe(`lifty-first-run:${run}:1`);
 });
});

// SQL creates a new durable verification request after a blocked attempt or an
// expired verifier lease. This boundary must use that new identity, rather than
// retaining the first request's Trigger idempotency key.
it.each(["blocked verification", "expired verifier lease"])("re-request after %s reaches a fresh verifier task", async () => {
  const fresh = "55555555-5555-4555-8555-555555555555";
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: "task-run" }), { status: 200 }));
  const verification = createAcquisitionVerificationTrigger({
    apiUrl: "https://trigger.test",
    secretKey: "fixture-server-key",
    fetchImpl,
  });
  let call = 0;
  const rpc = vi.fn(async () => ({
    data: { ...status, recovery_ref: call++ === 0 ? recovery : fresh },
    error: null,
  }));
  const operation = createAcquisitionRecoveryOperations({
    enqueueVerification: verification,
    enqueueFirstRun: async () => { throw new Error("must not start acquisition"); },
  });
  const input = { workspace_ref: workspace, first_run_ref: run,
    operation: "request" as const, expected_acquisition_ref: run };
  await operation({ userId: run, client: { rpc } }, input);
  await operation({ userId: run, client: { rpc } }, input);
  const bodies = fetchImpl.mock.calls.map((request) => JSON.parse(String(request[1]?.body)));
  expect(bodies.map((body) => body.payload)).toEqual([{ recoveryRef: recovery }, { recoveryRef: fresh }]);
  expect(bodies.map((body) => body.options.idempotencyKey)).toEqual([
    `lifty-discovery-reconcile:${recovery}`, `lifty-discovery-reconcile:${fresh}`,
  ]);
});
