#!/usr/bin/env node
// LIF-628: real Auth + PostgREST, real REST handlers, fixture-only SQL control.
// No production URL, key or database option is accepted by this harness.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { createApp } from '../dist/app.js';
import { createSupabaseAuthenticator } from '../dist/supabase-auth.js';
import * as workspace from '../dist/workspace-operations.js';

const output = process.argv[2];
if (!output) throw new Error('usage: node scripts/test-isolation-local.mjs <new-receipt.json>');
const containers = ['lif626628_postgres', 'lif626628_auth', 'lif626628_rest'];
for (const name of containers) {
  const info = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
  const networks = Object.keys(info.NetworkSettings.Networks);
  if (!networks.length || networks.some(n => !JSON.parse(execFileSync('docker', ['network','inspect',n]))[0].Internal)) {
    throw new Error('owned fixture requires internal-only networks');
  }
}
const privateJwk = JSON.parse(readFileSync('/tmp/lif626628-auth/key.json', 'utf8'));
const signingKey = await importJWK(privateJwk, 'ES256');
const { d: ignoredPrivatePart, ...publicJwk } = privateJwk;
const base = 'http://lif626628_fixture';
const checks = [];
const logs = [];
const protectedValues = [];
function check(condition, name) {
  checks.push({ name, passed: !!condition });
  if (checks.length % 20 === 0) console.log(JSON.stringify({assertions:checks.length}));
  if (!condition) throw new Error(name);
}
function subprocess(argv, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', argv, { stdio: ['pipe','pipe','pipe'] });
    let stdout = '';
    proc.stdout.on('data', data => { stdout += data; });
    // Do not expose upstream bodies, fixture credentials or SQL parameters.
    proc.stderr.resume();
    proc.on('error', () => reject(new Error('fixture_process_unavailable')));
    proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error('fixture_process_failed')));
    proc.stdin.end(input);
  });
}
async function sql(query) {
  return (await subprocess(['exec','-i','lif626628_postgres','psql','-XqAt','-vON_ERROR_STOP=1','-U','postgres','-d','postgres'], query)).trim();
}
// A persistent transport avoids host-published ports and keeps the fixture
// network unable to reach real providers. Only this task's three services run.
const transportCode = `
 import readline from 'node:readline';
 const lines=readline.createInterface({input:process.stdin});
 lines.on('line',async line=>{
  const {id,url,init}=JSON.parse(line);
  try {
   const response=await fetch(url,{...init,signal:AbortSignal.timeout(10000)});
   process.stdout.write(JSON.stringify({id,status:response.status,body:await response.text()})+'\\n');
  } catch { process.stdout.write(JSON.stringify({id,error:true})+'\\n'); }
 });
`;
const transport = spawn('docker',['run','--rm','-i','--name','lif626628_http','--network','lif626628_isolated','node:26.0.0-bookworm-slim','node','--input-type=module','-e',transportCode],{stdio:['pipe','pipe','pipe']});
transport.stderr.resume();
const pending = new Map();
let buffer=''; let sequence=0;
transport.stdout.on('data',chunk=>{
 buffer+=chunk;
 let newline;
 while ((newline=buffer.indexOf('\n'))>=0) {
  const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
  const result=JSON.parse(line);const waiter=pending.get(result.id);pending.delete(result.id);
  if (result.error) waiter?.reject(new Error('fixture_http_unavailable'));else waiter?.resolve(result);
 }
});
const transportExit = new Promise(resolve=>transport.on('close',()=>{
 for (const waiter of pending.values()) waiter.reject(new Error('fixture_transport_closed'));
 pending.clear();resolve();
}));
async function bridge(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== base) throw new Error('external_fixture_request_denied');
  let upstream;
  if (url.pathname.startsWith('/rest/v1/')) upstream = 'http://lif626628_rest:3000'+url.pathname.slice(8)+url.search;
  else if (url.pathname.startsWith('/auth/v1/')) upstream = 'http://lif626628_auth:9999'+url.pathname.slice(8)+url.search;
  else throw new Error('unknown_fixture_surface');
  const id=++sequence;
  const result=await new Promise((resolve,reject)=>{
   pending.set(id,{resolve,reject});
   transport.stdin.write(JSON.stringify({id,url:upstream,init:{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),...(init.body==null?{}:{body:String(init.body)})}})+'\n');
  });
  return new Response([204,304].includes(result.status)?null:result.body,{status:result.status,headers:{'content-type':'application/json'}});
}
async function request(path, token, method = 'GET', body, extra = {}) {
  const response = await bridge(base+path, { method,
    headers: { 'content-type':'application/json', ...(token ? {authorization:'Bearer '+token}:{}), ...extra },
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  const text = await response.text();
  return { status:response.status, text, body:text ? JSON.parse(text):null };
}
const app = createApp({
  authenticate: createSupabaseAuthenticator({ supabaseUrl:base, publishableKey:'sb_publishable_isolated_fixture', jwks:{keys:[publicJwk]} }, {fetch:bridge}),
  getWorkspace:workspace.getWorkspaceStatus, createWorkspace:workspace.createWorkspace,
  getOnboardingContext:workspace.getOnboardingContext, getOnboardingStatus:workspace.getOnboardingStatus,
  submitOnboarding:workspace.submitOnboarding, getConfig:workspace.getConfig,
  // Explicit partial-failure injection: external workers/providers never run.
  enqueueOnboardingImport:async () => { throw new Error('fixture_queue_unavailable'); },
  log:event => logs.push(event),
});
async function api(path, token, method='GET', body) {
  const response = await app.request(path, {method,
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  const text = await response.text();
  return {status:response.status,text,body:text?JSON.parse(text):null};
}
async function signed(claims, expires='5m') {
  return new SignJWT(claims).setProtectedHeader({alg:'ES256',kid:privateJwk.kid})
    .setAudience('authenticated').setIssuer(base+'/auth/v1').setIssuedAt().setExpirationTime(expires).sign(signingKey);
}
let failure = null;
try {
  check(await sql('show cron.launch_active_jobs;') === 'off','external cron execution disabled');
  const tag = randomUUID();
  const founders = [];
  for (const letter of ['a','b']) {
    const email = `lif628-${tag}-${letter}@example.test`;
    const password = 'Isolated-fixture-'+randomUUID();
    protectedValues.push(password);
    const signup = await request('/auth/v1/signup',null,'POST',{email,password});
    check(signup.status === 200 && !!signup.body.access_token,'clean founder '+letter+' signup');
    const login = await request('/auth/v1/token?grant_type=password',null,'POST',{email,password});
    check(login.status === 200 && !!login.body.access_token,'founder '+letter+' login');
    const token = login.body.access_token;
    protectedValues.push(token,login.body.refresh_token);
    const founder = {token,id:login.body.user.id,name:'LIF628 '+tag+' '+letter};
    check((await api('/v1/workspace',token)).body.state === 'needs_workspace','founder '+letter+' starts without workspace');
    const created = await api('/v1/workspace',token,'POST',{name:founder.name});
    check(created.status === 201 || created.status === 200,'founder '+letter+' provisions through REST');
    founder.workspace = JSON.parse(await sql(`select jsonb_build_object('id',w.id) from public.workspaces w join public.workspace_memberships m on m.workspace_id=w.id where m.user_id='${founder.id}'`)).id;
    const repeat = await api('/v1/workspace',token,'POST',{name:founder.name});
    check([200,201].includes(repeat.status),'workspace retry is idempotent');
    check(await sql(`select count(*) from public.workspace_memberships where user_id='${founder.id}'`) === '1','workspace retry creates no extra membership');
    founders.push(founder);
  }
  const [a,b] = founders;
  check(a.workspace !== b.workspace,'founders own distinct workspaces');
  const service = await signed({role:'service_role'});
  protectedValues.push(service);
  const leads = [randomUUID(),randomUUID()];
  const campaigns = [randomUUID(),randomUUID()];
  const providerSecret = 'lif628-provider-'+randomUUID();
  protectedValues.push(providerSecret);
  await sql(`insert into public.campaigns(id,campaign_key,display_name,platform,persona_type,sequence_name,is_active,workspace_id) values ('${campaigns[0]}','${campaigns[0]}','Fixture A','instantly','Founder','fixture',false,'${a.workspace}'),('${campaigns[1]}','${campaigns[1]}','Fixture B','instantly','Founder','fixture',false,'${b.workspace}');
    with secret as (select vault.create_secret('${providerSecret}','lif628-${tag}') id) insert into public.workspace_integrations(workspace_id,tool,api_key_secret_id,metadata,is_active) select '${a.workspace}','apollo',id,'{}'::jsonb,true from secret;`);
  await sql(`insert into public.leads(id,email,workspace_id) values ('${leads[0]}','lead-a@lif628.test','${a.workspace}'),('${leads[1]}','lead-b@lif628.test','${b.workspace}');`);
  for (const [i,actor] of founders.entries()) {
    const other = founders[1-i];
    for (const table of ['workspaces','workspace_memberships','leads','campaigns']) {
      const column = table==='workspaces'?'id':'workspace_id';
      const own = await request(`/rest/v1/${table}?${column}=eq.${actor.workspace}`,actor.token);
      const foreign = await request(`/rest/v1/${table}?${column}=eq.${other.workspace}`,actor.token);
      check(own.status===200 && own.body.length>0,table+' own read '+i);
      check(foreign.status===200 && foreign.body.length===0,table+' foreign read hidden '+i);
    }
    const feedback = randomUUID();
    const created = await request('/rest/v1/lead_feedback',actor.token,'POST',{id:feedback,lead_id:leads[i],user_id:actor.id,rating:'up'},{prefer:'return=representation'});
    check(created.status===201 && created.body.length===1,'own feedback insert '+i);
    const valid = await request('/rest/v1/lead_feedback?id=eq.'+feedback,actor.token,'PATCH',{note:'own-edit'},{prefer:'return=representation'});
    check(valid.status===200 && valid.body[0].note==='own-edit','own feedback update '+i);
    const denied = await request('/rest/v1/lead_feedback?id=eq.'+feedback,actor.token,'PATCH',{lead_id:leads[1-i]});
    check(denied.status===403,'cross-workspace feedback reassignment denied '+i);
    const crossInsert = await request('/rest/v1/lead_feedback',actor.token,'POST',{lead_id:leads[1-i],user_id:actor.id,rating:'up'});
    check(crossInsert.status===403,'cross-workspace feedback insert denied '+i);
    const upsert = await request('/rest/v1/lead_feedback?on_conflict=id',actor.token,'POST',{id:feedback,lead_id:leads[1-i],user_id:actor.id,rating:'up'},{prefer:'resolution=merge-duplicates'});
    check(upsert.status===403,'cross-workspace upsert denied '+i);
    check(await sql(`select lead_id::text from public.lead_feedback where id='${feedback}'`)===leads[i],'denied writes preserve original parent '+i);
    const otherDelete = await request('/rest/v1/lead_feedback?id=eq.'+feedback,other.token,'DELETE',undefined,{prefer:'return=representation'});
    check(otherDelete.status===200 && otherDelete.body.length===0,'foreign delete writes nothing '+i);
    const ownDelete = await request('/rest/v1/lead_feedback?id=eq.'+feedback,actor.token,'DELETE',undefined,{prefer:'return=representation'});
    check(ownDelete.status===200 && ownDelete.body.length===1,'own feedback delete '+i);
    const injected = await api('/v1/workspace',actor.token,'POST',{name:'injected',workspace_id:other.workspace});
    check(injected.status===422 || injected.status===400,'authoritative workspace injection rejected '+i);
    const context = await api('/v1/onboarding/context?workspace_ref='+other.workspace,actor.token);
    check(context.status===200 && context.body.workspace.name===actor.name,'onboarding context ignores foreign selector '+i);
  }
  const resolverInput = {p_workspace_id:a.workspace,p_tool:'apollo',p_caller:'webhook-apollo',p_request_id:randomUUID()};
  for (const actor of founders) {
    const metadata = await request('/rest/v1/workspace_integrations?workspace_id=eq.'+a.workspace,actor.token);
    check(metadata.status===403,'unrestricted integration SELECT is blocked');
    const approved = await request('/rest/v1/workspace_integrations?select=workspace_id,tool,metadata,is_active&workspace_id=eq.'+a.workspace,actor.token);
    check(approved.status===200 && (actor===a?approved.body.length===1:approved.body.length===0),'approved metadata columns remain tenant scoped');
    check(!approved.text.includes(providerSecret),'approved metadata contains no plaintext credential');
    const pointer = await request('/rest/v1/workspace_integrations?select=api_key_secret_id',actor.token);
    check(pointer.status===403,'credential pointer column is not client-readable');
    check(!metadata.text.includes(providerSecret),'metadata contains no plaintext credential');
    const secret = await request('/rest/v1/rpc/resolve_workspace_integration_secret',actor.token,'POST',resolverInput);
    check([403,404].includes(secret.status) && !secret.text.includes(providerSecret),'founder cannot retrieve plaintext provider secret');
    const privateAudit = await request('/rest/v1/workspace_integration_secret_access_audit',actor.token,'GET',undefined,{'accept-profile':'private'});
    check([403,406].includes(privateAudit.status),'private audit schema is not exposed');
  }
  const resolved = await request('/rest/v1/rpc/resolve_workspace_integration_secret',service,'POST',resolverInput);
  check(resolved.status===200 && resolved.body===providerSecret,'approved backend resolver succeeds with audited contract');
  check(await sql(`select count(*) from private.workspace_integration_secret_access_audit where request_id='${resolverInput.p_request_id}'`)==='1','backend credential use creates exactly one audit entry');
  const unapproved = await request('/rest/v1/rpc/resolve_workspace_integration_secret',service,'POST',{...resolverInput,p_caller:'unreviewed'});
  check(unapproved.status===400 && !unapproved.text.includes(providerSecret),'unapproved backend caller fails without secret disclosure');
  const draftTemplate = JSON.parse(readFileSync(new URL('fixtures/lif628-onboarding-draft.json',import.meta.url),'utf8'));
  for (const actor of founders) {
    const context = await api('/v1/onboarding/context',actor.token);
    const draft = {...draftTemplate,company:{...draftTemplate.company,name:actor.name}};
    const configuration = {contract_version:'lifty-onboarding-config.v1',context_version:context.body.context_version,
      icp_config:{label:'Fixture ICP',person_locations:['United States'],organization_industries:['industrial automation'],organization_num_employees_ranges:['51,200'],person_seniorities:null,personas:draft.personas.map(({name,titles})=>({name,titles}))},
      scout_overlay:['## ICP gate','Research manufacturers with physical inspection needs. '.repeat(6),'## Hard disqualifiers','Reject consumer businesses.','## Size gate','Select 51–200 employees.','## Tier definitions','A/B/C/non-ICP by confirmed manufacturing fit.'].join('\n')};
    protectedValues.push(configuration.scout_overlay);
    const failed = await api('/v1/onboarding',actor.token,'POST',{draft,configuration});
    check(failed.status===500 || failed.status===502,'queue partial failure returns a safe error');
    check(!failed.text.includes(configuration.scout_overlay),'onboarding error does not expose local draft');
    const rows = JSON.parse(await sql(`select jsonb_agg(jsonb_build_object('id',id)) from public.lifty_onboarding_submissions where workspace_id='${actor.workspace}'`));
    check(rows.length===1,'accepted onboarding receipt survives queue failure');
    const replay = await Promise.all([0,1].map(()=>request('/rest/v1/rpc/submit_lifty_onboarding',actor.token,'POST',{draft,configuration})));
    check(replay.every(r=>r.status===200 && r.body.created===false && r.body.submission_ref===rows[0].id),'concurrent onboarding retries reuse the same receipt');
    const other = actor===a?b:a;
    const cross = await request('/rest/v1/rpc/submit_lifty_onboarding',other.token,'POST',{draft,configuration});
    check(cross.status===409,'another workspace cannot reuse onboarding context');
    const imported = await request('/rest/v1/rpc/import_lifty_onboarding',service,'POST',{p_submission_id:rows[0].id,p_icp:configuration.icp_config,p_scout_overlay:configuration.scout_overlay,p_source:'lif628_fixture'});
    check(imported.status===200 && imported.body.status==='imported','approved worker imports exact local configuration');
    const done = await api('/v1/onboarding',actor.token,'POST',{draft,configuration});
    check(done.status===200 && done.body.state==='imported','completed onboarding retry is idempotent');
    check(await sql(`select count(*) from public.icp_configs where workspace_id='${actor.workspace}'`)==='1','concurrency and replay create one ICP');
  }
  check((await request('/rest/v1/leads?id=in.('+leads.join(',')+')',service)).body.length===2,'approved backend role reads both seeded leads');
  const expired = await signed({sub:a.id,role:'authenticated',session_id:randomUUID()},Math.floor(Date.now()/1000)-60);
  for (const token of [null,'malformed.jwt.token',expired,service]) {
    const result = await api('/v1/workspace',token,'POST',{name:'denied'});
    check(result.status===401,'REST rejects missing invalid expired or backend user credentials');
    check(!protectedValues.some(v=>result.text.includes(v)),'authentication error is redacted');
  }
  // Direct API: session is checked even when a JWT signature remains valid.
  await sql(`delete from public.workspace_memberships where user_id='${a.id}';`);
  check((await request('/rest/v1/leads?workspace_id=eq.'+a.workspace,a.token)).body.length===0,'membership revocation removes direct data visibility');
  check((await api('/v1/workspace',a.token)).body.state==='needs_workspace','membership revocation removes REST workspace visibility');
  await sql(`insert into public.workspace_memberships(user_id,workspace_id) values('${a.id}','${a.workspace}');`);
  const logout = await request('/auth/v1/logout?scope=global',a.token,'POST');
  check(logout.status===204,'real Auth global logout succeeds');
  check((await request('/rest/v1/leads',a.token)).status===401,'Data API rejects signed JWT after session revocation');
  check((await api('/v1/workspace',a.token)).status===401,'REST rejects signed JWT after session revocation');
  check((await request('/rest/v1/leads?workspace_id=eq.'+b.workspace,b.token)).body.length===1,'other founder remains unaffected by logout');
  check(await sql(`select count(*) from public.leads where id in ('${leads[0]}','${leads[1]}')`)==='2','denial and revocation preserve tenant data');
  check(!protectedValues.some(v=>JSON.stringify(logs).includes(v)),'captured application logs contain no fixture credentials');
} catch (error) {
  failure = error instanceof Error ? error.message : 'fixture_failed';
} finally {
  transport.stdin.end();
  await transportExit;
  const receipt = {kind:'local-auth-data-api-rest-isolation',production_acceptance:false,
    source_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    source_tree_sha256:createHash('sha256').update(execFileSync('git',['diff','HEAD'])).digest('hex'),
    commands:['npm run verify','node scripts/test-isolation-local.mjs <receipt>'],
    environment:{database:'owned fixture only',auth:'v2.188.1',postgrest:'v14.10',rest_transport:'Hono Request in process; real Auth/PostgREST over isolated HTTP'},
    passed:!failure,checks,failure,
    exclusions:['deployed source/ledger match','external provider and worker execution','all public object positive fixtures','Realtime session revocation'],
  };
  writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({passed:!failure,assertions:checks.length,failure}));
  if (failure) process.exitCode=1;
}
