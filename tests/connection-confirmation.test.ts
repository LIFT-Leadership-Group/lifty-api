import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { sealHubspotConnectIntent } from '../src/hubspot-state.js';
import { sealSlackConnectIntent } from '../src/slack-state.js';
import { sealAttioConnectIntent } from '../src/attio-state.js';

describe('connection document boundary', () => {
  it.each(['hubspot', 'slack', 'attio'] as const)('renders %s confirmation before exchanging the authorization', async provider => {
    const complete = vi.fn(async () => ({ portalId:'123', hubDomain:null, teamId:'T1', teamName:'Test' }));
    const state = { hubspot: sealHubspotConnectIntent, slack: sealSlackConnectIntent, attio: sealAttioConnectIntent }[provider]('a'.repeat(64), 'secret');
    const app = createApp({completeHubspotCallback:complete, completeSlackCallback:complete});
    const response = await app.request(`https://api.lifty.test/${provider}/callback?state=${state}&code=PRIVATE_CODE`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Checking your connection');
    expect(complete).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach } from 'vitest';
import { CONNECTION_FLOWS, CONFIRMATION_SCRIPT, createConfirmationRouter, connectionFetch, type ConnectionFlow } from '../src/connection-confirmation.js';
import { createOAuthConfirmation } from '../src/oauth-confirmation.js';
import { createWarmupSetup } from '../src/warmup-setup.js';
import { createAccountConnection } from '../src/account-connection.js';
const headers={origin:'https://api.lifty.test','content-type':'application/json','x-lifty-connection':'1'};
const flows=Object.keys(CONNECTION_FLOWS) as ConnectionFlow[];
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it.each(flows)('%s uses a fast shell and contains transient status failures',async flow=>{
  const status=vi.fn().mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM_BODY')).mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'connected',account:'verified@example.test'});
  const process=vi.fn(async()=>({status:'pending' as const}));
  const router=createConfirmationRouter(flow,{validate:()=>{},status,process});
  const path=CONNECTION_FLOWS[flow].path,key=['email','linkedin'].includes(flow)?'intent':'state';
  const res=await router.request(`https://api.lifty.test${path}?${key}=capability&code=PRIVATE_CODE`);
  expect(res.status).toBe(200);expect(process).not.toHaveBeenCalled();expect(status).not.toHaveBeenCalled();
  const html=await res.text();expect(html).not.toContain('PRIVATE_CODE');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(res.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  for(const expected of [{status:'pending'},{status:'pending'},{status:'connected',account:'verified@example.test'}]){
    const check=await router.request(`https://api.lifty.test${path}/status`,{method:'POST',headers,body:JSON.stringify({state:'capability'})});
    expect(await check.json()).toEqual(expected);
  }
});
it('bounds stalled dependency work and preserves a pending result',async()=>{
  vi.useFakeTimers();
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
  const rawFetch=vi.fn((_input:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE_CONNECTION_ERROR')),{once:true});
  }));
  const fetchImpl=connectionFetch(rawFetch as typeof fetch),logs:unknown[]=[];
  const router=createConfirmationRouter('email',{validate:()=>{},status:async()=>{await fetchImpl('https://api.unipile.test/account');return {status:'connected',account:null};}},{log:e=>logs.push(e)});
  const request=router.request('https://api.lifty.test/connect/email/return/status',{method:'POST',headers,body:'{"state":"capability"}'});
  await vi.advanceTimersByTimeAsync(8000);
  const response=await request;expect(response.status).toBe(202);expect(await response.json()).toEqual({status:'pending'});
  expect(logs).toMatchObject([{upstream_outcome:'timeout',outcome:'pending',elapsed_ms:8000}]);
  expect(JSON.stringify(logs)).not.toContain('PRIVATE');
});
it('logs the provider error code from a failed return, never its free text',async()=>{
  const logs:{provider_error?:string}[]=[];
  const router=createConfirmationRouter('email',{validate:()=>{},status:async()=>({status:'failed',reason:'provider'})},{log:e=>logs.push(e)});
  for(const errorType of ['api/account_restricted','PRIVATE detail from provider'])
    await router.request('https://api.lifty.test/connect/email/return/status',{method:'POST',headers,body:JSON.stringify({state:'capability',errorType})});
  expect(logs.map(x=>x.provider_error)).toEqual(['api/account_restricted',undefined]);
  expect(JSON.stringify(logs)).not.toContain('PRIVATE');
});
it('rejects cross-origin requests, extra fields, oversized input and secrets on status',async()=>{
  const work=vi.fn(async()=>({status:'pending' as const}));
  const router=createConfirmationRouter('slack',{validate:()=>{},status:work,process:work});
  for(const [supplied,body] of [[{...headers,origin:'https://evil.test'},'{"state":"capability"}'],[headers,'{"state":"capability","account_id":"forged"}'],[headers,JSON.stringify({state:'capability',code:'private'})],[headers,'x'.repeat(13000)]] as const){
    const response=await router.request('https://api.lifty.test/slack/callback/status',{method:'POST',headers:supplied,body});
    expect(await response.json()).toEqual({status:'failed',reason:'invalid'});
  }
  expect(work).not.toHaveBeenCalled();
});
it('registers every browser callback/return in the shared inventory, excluding provider webhooks',()=>{
  const setup=createWarmupSetup({publicBaseUrl:'https://api.lifty.test',serverKey:'s'.repeat(32),supabaseUrl:'https://db.test',publishableKey:'public',googleClientId:'client',googleClientSecret:'secret',mailivery:{apiKey:'key'}});
  const accounts=createAccountConnection({publicBaseUrl:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',
    serverKeys:{email:'e'.repeat(32),linkedin:'l'.repeat(32)},provider:{v2:{accessToken:'token',applicationId:'app_1',hostedAuthOrigins:['https://connect.lifty.test']}}});
  const app=createApp({warmupSetup:setup,accounts:{connection:accounts,origin:'https://api.lifty.test',hostedOrigins:['https://connect.lifty.test']}});
  const browserRoutes=app.routes.filter(r=>r.method==='GET'&&/\/(callback|return)$/.test(r.path)).map(r=>r.path).sort();
  expect(browserRoutes).toEqual(Object.values(CONNECTION_FLOWS).map(x=>x.path).sort());
  const entries=app.routes.filter(r=>r.method==='GET'&&/^\/(hubspot|slack|attio|connect|warmup)\//.test(r.path)&&!browserRoutes.includes(r.path)).map(r=>r.path).sort();
  expect(entries).toEqual(Object.values(CONNECTION_FLOWS).flatMap(x=>[...x.entries]).sort());
  for(const path of browserRoutes)for(const stage of ['status','process'])expect(app.routes.some(r=>r.method==='POST'&&r.path===path+'/'+stage)).toBe(true);
});

it('keeps malformed dependency receipts pending instead of inventing an invalid account',async()=>{
  const adapter=createOAuthConfirmation({provider:'hubspot',origin:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',
    open:()=> 'a'.repeat(64),complete:vi.fn(),fetchImpl:vi.fn(async()=>Response.json({unexpected:true})) as typeof fetch});
  const response=await createConfirmationRouter('hubspot',adapter).request('https://api.lifty.test/hubspot/callback/status',{
    method:'POST',headers,body:'{"state":"capability"}'});
  expect(response.status).toBe(202);expect(await response.json()).toEqual({status:'pending'});
});

function browser(href:string,fetchImpl:typeof fetch){
  const elements:Record<string,{textContent:string;hidden:boolean;dataset:Record<string,string>}>=Object.fromEntries(['confirmation','confirmation-title','confirmation-detail','confirmation-spinner'].map(k=>[k,{textContent:'',hidden:false,dataset:{}}]));
  elements.confirmation!.dataset={label:'email',warmup:'false',stateKey:href.includes('/connect/')?'intent':'state'};
  const location={href};
  const history={replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{location.href=new URL(path,location.href).href;})};
  const context={URL,AbortController,JSON,Date,Promise,setTimeout,clearTimeout,location,history,fetch:fetchImpl,document:{getElementById:(id:string)=>elements[id]}};
  return {elements,location,history,run:()=>runInNewContext(CONFIRMATION_SCRIPT,context) as Promise<void>};
}
it('submits a code once, survives a lost response, displays late success, and reload only reads status',async()=>{
  vi.useFakeTimers();const requests:{stage:string;body:Record<string,string>}[]=[];let checks=0;
  const fetchImpl=vi.fn(async(input:unknown,init?:RequestInit)=>{
    const stage=String(input).split('/').at(-1)!;requests.push({stage,body:JSON.parse(String(init!.body))});
    if(stage==='process')throw new Error('response lost after accepted');
    return Response.json(++checks<2?{status:'pending'}:{status:'connected',account:'<img onerror=alert(1)>@example.test'});
  }) as typeof fetch;
  const page=browser('https://api.lifty.test/hubspot/callback?state=capability&code=PRIVATE_CODE',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.history.replaceState).toHaveBeenCalled();expect(page.location.href).not.toContain('PRIVATE_CODE');
  expect(requests.filter(r=>r.stage==='process')).toEqual([{stage:'process',body:{state:'capability',code:'PRIVATE_CODE'}}]);
  expect(requests.filter(r=>r.stage==='status').every(r=>!('code' in r.body))).toBe(true);
  expect(page.elements['confirmation-title']!.textContent).toBe('email is connected');
  expect(page.elements['confirmation-detail']!.textContent).toContain('<img onerror=alert(1)>@example.test');
  const reload=browser(page.location.href,fetchImpl);const again=reload.run();await vi.runAllTimersAsync();await again;
  expect(requests.filter(r=>r.stage==='process')).toHaveLength(1);
});
it('a failed status transport never navigates away or spins forever',async()=>{
  vi.useFakeTimers();
  const fetchImpl=vi.fn(async()=>new Response('Bad gateway',{status:502})) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability&state=forged',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Still checking');expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
  expect(page.location.href).toBe('https://api.lifty.test/connect/email/return?intent=capability');
  expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThan(20);
});
it.each(['hubspot','slack','attio'] as const)('%s never repeats an exchanged code and reads durable success after a lost response',async provider=>{
  let claimed=false,connected=false;const complete=vi.fn(async()=>{connected=true;throw new Error('lost store response');});
  const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const args=JSON.parse(String(init!.body));expect(args.p_intent_token).toBe('a'.repeat(64));
    const result=connected?{status:'connected',account:null}:{status:'pending'};
    const claim=args.p_operation==='claim'&&!claimed;if(claim)claimed=true;
    return Response.json({result,claimed:claim});
  }) as typeof fetch;
  const adapter=createOAuthConfirmation({provider,origin:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',open:()=> 'a'.repeat(64),complete,fetchImpl});
  const router=createConfirmationRouter(provider,adapter);
  for(let i=0;i<2;i++){
    const response=await router.request(`https://api.lifty.test/${provider}/callback/process`,{method:'POST',headers,body:'{"state":"capability","code":"private"}'});
    expect(await response.json()).toEqual({status:'connected',account:null});
  }
  expect(complete).toHaveBeenCalledTimes(1);
});
