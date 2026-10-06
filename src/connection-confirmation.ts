import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { PublicError } from './errors.js';
import { renderLiftyPage } from './lifty-brand.js';

/** Every browser connection return is registered here. Webhooks are separate. */
export const CONNECTION_FLOWS = {
  hubspot: { path:'/hubspot/callback', label:'HubSpot', entries:['/hubspot/start'] },
  slack: { path:'/slack/callback', label:'Slack', entries:['/slack/start'] },
  attio: { path:'/attio/callback', label:'Attio', entries:['/attio/start'] },
  warmup: { path:'/warmup/google/callback', label:'email warmup', entries:['/warmup/setup','/warmup/received'] },
  email: { path:'/connect/email/return', label:'email', entries:['/connect/email'] },
  linkedin: { path:'/connect/linkedin/return', label:'LinkedIn', entries:['/connect/linkedin'] },
} as const;
export type ConnectionFlow = keyof typeof CONNECTION_FLOWS;
export const ConfirmationResult = z.discriminatedUnion('status', [
  z.object({status:z.literal('pending')}),
  z.object({status:z.literal('connected'), account:z.string().max(254).nullable()}),
  z.object({status:z.literal('failed'), reason:z.enum(['canceled','exists','provider','verification','ended','invalid'])}),
]);
export type ConfirmationResult = z.infer<typeof ConfirmationResult>;
const Input = z.strictObject({state:z.string().min(1).max(4096),code:z.string().min(1).max(4096).optional(),
  denied:z.boolean().optional(),errorType:z.string().max(100).optional()});
export type ConfirmationInput = z.infer<typeof Input>;
export interface ConfirmationAdapter {
  origin?:string;
  // Local signature/shape checks only. Remote authority is checked by process/status.
  validate(input:ConfirmationInput, context:Context):void;
  process?(input:ConfirmationInput, context:Context):Promise<ConfirmationResult>;
  status(input:ConfirmationInput, context:Context):Promise<ConfirmationResult>;
}
export type ConfirmationAdapters = Partial<Record<ConnectionFlow, ConfirmationAdapter>>;
const deadline = new AsyncLocalStorage<{signal:AbortSignal;upstream_status?:number;upstream_outcome?:string}>();
/** All dependency I/O in a confirmation request shares one deadline, including body reads. */
export function connectionFetch(fetchImpl:typeof fetch):typeof fetch {
  return async (input, init) => {
    const parent = deadline.getStore();
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      const response=await fetchImpl(input, {...init, ...(parent ? {signal:inherited ? AbortSignal.any([parent.signal,inherited]) : parent.signal} : {})});
      if(parent&&(!parent.upstream_outcome||parent.upstream_outcome==='response')){parent.upstream_status=response.status;parent.upstream_outcome=response.ok?'response':'http_error';}
      return response;
    }catch(error){if(parent){parent.upstream_outcome=parent.signal.aborted||inherited?.aborted?'timeout':'transport';delete parent.upstream_status;}throw error;}
  };
}
export const pendingConfirmation = ():ConfirmationResult => ({status:'pending'});
export const invalidConfirmation = ():ConfirmationResult => ({status:'failed',reason:'invalid'});

// No credentials are rendered into HTML or persisted in browser storage. The
// existing callback URL is read once, scrubbed before I/O, then the code is POSTed
// once. Reloads and lost responses only read the same durable attempt.
export const CONFIRMATION_SCRIPT = String.raw`(async function(){
var url=new URL(location.href),q=url.searchParams,root=document.getElementById('confirmation'),key=root.dataset.stateKey,body={state:q.get(key)||''};
var code=q.get('code'),denied=q.has('error'),errorType=q.get('error_type')||(q.has('error_title')?'provider_rejected':'');
var title=document.getElementById('confirmation-title'),detail=document.getElementById('confirmation-detail'),spinner=document.getElementById('confirmation-spinner');
var label=root.dataset.label,warmup=root.dataset.warmup==='true',finished=false;
url.search='';url.searchParams.set(key,body.state);history.replaceState(null,'',url.pathname+url.search);
function show(result){
 if(finished||!result||!['pending','connected','failed'].includes(result.status))return;
 if(result.status==='pending')return;
 finished=true;spinner.hidden=true;
 if(result.status==='connected'){title.textContent=warmup?'Warmup is running':label+' is connected';detail.textContent='Lifty verified '+(result.account||'the connection')+'. Return to Lifty to continue. Connecting does not start outreach.';if(label==='Slack')detail.textContent+=' Invite @Lifty to the channel where you want notifications, then tell Lifty which channel you chose.';}
 else{title.textContent='Connection needs attention';detail.textContent=result.reason==='canceled'?'Authorization was not completed. Return to Lifty to check this attempt.':result.reason==='verification'?'The selected account could not be verified. Return to Lifty for help.':'Return to Lifty to check this attempt and the next step before requesting another link.';if(label==='HubSpot'&&result.reason==='canceled')detail.textContent+=' If permissions were blocked, ask a HubSpot super admin to approve Lifty in Settings > Integrations > Connected Apps > Approved apps.';}
}
async function request(stage,payload,ms){
 var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},ms);
 try{var response=await fetch(url.pathname+'/'+stage,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-lifty-connection':'1'},body:JSON.stringify(payload),signal:controller.signal});if(response.ok)show(await response.json());}catch(e){}finally{clearTimeout(timer);}
}
if(code||denied){var submission=Object.assign({},body,code?{code:code}:{denied:true});code=null;request('process',submission,50000);}
if(errorType)body.errorType=errorType;
var until=Date.now()+90000,delay=1000;
while(!finished&&Date.now()<until){await request('status',body,10000);if(finished)break;await new Promise(function(resolve){setTimeout(resolve,delay)});delay=Math.min(delay*2,8000);}
if(!finished){spinner.hidden=true;title.textContent='Still checking';detail.textContent='The result is not confirmed yet. Return to Lifty to check this same attempt. Do not repeat authorization just because this page timed out.';}
})();`;
const scriptHash = createHash('sha256').update(CONFIRMATION_SCRIPT).digest('base64');
export function renderConfirmationPage(flow:ConnectionFlow, valid=true) {
  const {label}=CONNECTION_FLOWS[flow];
  return renderLiftyPage({title:valid?'Checking your connection':'Connection needs attention',content:
    `<section id="confirmation" data-label="${label}" data-warmup="${flow==='warmup'}" data-state-key="${['email','linkedin'].includes(flow)?'intent':'state'}" aria-live="polite"><div id="confirmation-spinner" class="symbol" aria-hidden="true"${valid?'':' hidden'}><span class="spinner"></span></div><h1 id="confirmation-title">${valid?'Checking your connection':'Connection needs attention'}</h1><p id="confirmation-detail" class="intro">${valid?'Lifty is verifying your '+label+' connection. This page will update automatically.':'Return to Lifty to check this attempt and get the next step.'}</p><p class="reassurance">Connecting does not start outreach.</p></section><noscript>JavaScript is needed to finish this connection here. Return to Lifty to check the attempt before requesting another link.</noscript>${valid?`<script>${CONFIRMATION_SCRIPT}</script>`:''}`});
}
export type ConfirmationLog = {flow:ConnectionFlow;stage:string;outcome:string;elapsed_ms:number;status:number;correlation:string;upstream_status?:number;upstream_outcome?:string;provider_error?:string};
export function createConfirmationRouter(flow:ConnectionFlow, adapter:ConfirmationAdapter, options:{prefix?:string;origin?:string;log?:(event:ConfirmationLog)=>void}={}) {
  const app=new Hono();
  const path=CONNECTION_FLOWS[flow].path.slice((options.prefix??'').length);
  const headers=(c:Context)=>{
    c.header('cache-control','no-store, no-transform');c.header('referrer-policy','no-referrer');c.header('x-content-type-options','nosniff');
    c.header('content-security-policy',`default-src 'none'; script-src 'sha256-${scriptHash}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  };
  app.get(path,c=>{
    headers(c);
    const q=new URL(c.req.url).searchParams;
    const key=['email','linkedin'].includes(flow)?'intent':'state';
    const parsed=Input.safeParse({state:q.get(key)??'',...(q.has('code')?{code:q.get('code')}:{}),...(q.has('error')?{denied:true}:{})});
    let valid=parsed.success && [key,'code','error'].every(key=>q.getAll(key).length<=1);
    if(valid&&parsed.success){try{adapter.validate(parsed.data,c);}catch{valid=false;}}
    return c.html(renderConfirmationPage(flow,valid),200);
  });
  for(const stage of ['process','status'] as const)app.post(path+'/'+stage,async c=>{
    headers(c);
    const origin=options.origin??new URL(c.req.url).origin;
    const supplied=c.req.header('origin');
    if(c.req.header('x-lifty-connection')!=='1'||!c.req.header('content-type')?.startsWith('application/json')
      ||c.req.header('sec-fetch-site')==='cross-site'||(supplied!==origin&&!(supplied==='null'&&c.req.header('sec-fetch-site')==='same-origin')))
      return c.json(invalidConfirmation(),403);
    const started=Date.now();const execution:{signal:AbortSignal;upstream_status?:number;upstream_outcome?:string}={signal:AbortSignal.timeout(stage==='process'?45000:8000)};let correlation='invalid',validated=false,providerError:string|undefined;let result:ConfirmationResult=pendingConfirmation(), status=200;
    try {
      const reader=c.req.raw.body?.getReader();if(!reader)return c.json(invalidConfirmation(),400);
      const cancel=()=>{void reader.cancel().catch(()=>{});};execution.signal.addEventListener('abort',cancel,{once:true});
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
        if(size>12288){await reader.cancel();return c.json(invalidConfirmation(),413);}chunks.push(next.value);}}
      finally{execution.signal.removeEventListener('abort',cancel);reader.releaseLock();}
      execution.signal.throwIfAborted();
      const input=Input.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      correlation=createHash('sha256').update(flow+'\0'+input.state).digest('hex').slice(0,24);
      if(stage==='status'&&(input.code||input.denied))return c.json(invalidConfirmation(),400);
      adapter.validate(input,c);
      validated=true;
      // A provider's error code (e.g. api/already_exists) is an untrusted hint but
      // the only record of why an attempt failed. Log codes only, never free text.
      if(input.errorType&&/^[a-z0-9_]{1,40}(\/[a-z0-9_]{1,40})?$/.test(input.errorType))providerError=input.errorType;
      const handler=stage==='process'?adapter.process:adapter.status;
      if(!handler)return c.json(invalidConfirmation(),400);
      // The handler remains awaited; request cancellation never launches an
      // untracked task. All real provider/DB fetches inherit this deadline.
      result=ConfirmationResult.parse(await deadline.run(execution,()=>handler(input,c)));
    }catch(error){
      if(!validated&&(error instanceof z.ZodError||error instanceof SyntaxError))result=invalidConfirmation();
      else if(error instanceof PublicError&&error.status>=400&&error.status<500&&error.code!=='WARMUP_SETUP_UNAVAILABLE')result=invalidConfirmation();
      else status=202;
    }
    options.log?.({flow,stage,outcome:result.status,elapsed_ms:Date.now()-started,status,correlation,...(execution.upstream_status===undefined?{}:{upstream_status:execution.upstream_status}),...(execution.upstream_outcome?{upstream_outcome:execution.upstream_outcome}:{}),...(providerError?{provider_error:providerError}:{})});
    return c.json(result,status===202?202:200);
  });
  return app;
}
