#!/usr/bin/env node
// LIF-628: disposable, internal-network-only services; never the shared stack.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK } from 'jose';
const action=process.argv[2];
const directory='/tmp/lif626628-auth';
const network='lif626628_isolated';
const names=['lif626628_rest','lif626628_auth','lif626628_postgres'];
const label='lifty.isolation-fixture=lif628';
function command(args, input) { return execFileSync('docker',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']}); }
function inspect(args) { try{return JSON.parse(command(args))[0];}catch{return null;} }
function owned(info) {return info?.Config?.Labels?.['lifty.isolation-fixture']==='lif628';}
async function waitFor(probe) {
 for (let i=0;i<30;i++) {try {if(probe())return;}catch{} await new Promise(r=>setTimeout(r,500));}
 throw new Error('fixture_service_not_ready');
}
if(action==='stop') {
 if(!existsSync(directory+'/ownership.json')) throw new Error('fixture_ownership_receipt_required');
 for(const name of names) {
  const info=inspect(['inspect',name]);
  if(info && !owned(info)) throw new Error('refusing_unowned_container');
  if(info) command(['rm','-f',name]);
 }
 const net=inspect(['network','inspect',network]);
 if(net) {
  if(net.Labels?.['lifty.isolation-fixture']!=='lif628'||Object.keys(net.Containers??{}).length) throw new Error('refusing_unowned_or_busy_network');
  command(['network','rm',network]);
 }
 rmSync(directory,{recursive:true,force:true});
 console.log('owned isolation fixture removed');
} else if(action==='start') {
 const dbRepo=resolve(process.argv[3]??'');
 const output=resolve(process.argv[4]??'');
 if(!process.argv[3]||!process.argv[4]||!existsSync(dbRepo+'/scripts/replay-isolation-migrations.py')) throw new Error('usage: isolation-fixture.mjs start <database-repo> <new-evidence-directory>');
 if(names.some(name=>inspect(['inspect',name]))||inspect(['network','inspect',network])||existsSync(directory)) throw new Error('fixture_already_exists_reuse_or_remove_its_owner_resources');
 mkdirSync(directory,{mode:0o700});
 writeFileSync(directory+'/ownership.json',JSON.stringify({label,names,network})+'\n',{mode:0o600});
 const {privateKey,publicKey}=await generateKeyPair('ES256',{extractable:true});
 const privateJwk={...await exportJWK(privateKey),kid:'lif626628-fixture-key',alg:'ES256',use:'sig'};
 const publicJwk={...await exportJWK(publicKey),kid:privateJwk.kid,alg:'ES256',use:'sig'};
 writeFileSync(directory+'/key.json',JSON.stringify(privateJwk),{mode:0o600});
 writeFileSync(directory+'/auth.env','GOTRUE_JWT_KEYS='+JSON.stringify([{...privateJwk,key_ops:['sign','verify']}])+'\nGOTRUE_JWT_ISSUER=http://lif626628_fixture/auth/v1\n',{mode:0o600});
 writeFileSync(directory+'/rest.env','PGRST_JWT_SECRET='+JSON.stringify({keys:[publicJwk]})+'\n',{mode:0o600});
 command(['network','create','--internal','--label',label,network]);
 command(['run','-d','--name','lif626628_postgres','--label',label,'--network',network,'-e','POSTGRES_PASSWORD=lif626628-local-fixture','public.ecr.aws/supabase/postgres:17.6.1.106','postgres','-D','/etc/postgresql','-c','cron.launch_active_jobs=off','-c',"listen_addresses=*"]);
 await waitFor(()=>command(['exec','lif626628_postgres','pg_isready','-h','127.0.0.1','-U','postgres']).includes('accepting connections'));
 command(['exec','-i','lif626628_postgres','psql','-XqAt','-h','127.0.0.1','-U','supabase_admin','-d','postgres','-vON_ERROR_STOP=1'],"alter role supabase_auth_admin password 'lif626628-local-fixture'; alter role authenticator password 'lif626628-local-fixture';");
 command(['run','-d','--name','lif626628_auth','--label',label,'--network',network,'--env-file',directory+'/auth.env',
  '-e','GOTRUE_DB_DRIVER=postgres','-e','GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:lif626628-local-fixture@lif626628_postgres:5432/postgres',
  '-e','GOTRUE_API_HOST=0.0.0.0','-e','GOTRUE_API_PORT=9999','-e','GOTRUE_SITE_URL=http://lif626628_fixture','-e','API_EXTERNAL_URL=http://lif626628_fixture/auth/v1',
  '-e','GOTRUE_JWT_SECRET=lif626628-isolated-fixture-signing-secret-only-2026','-e','GOTRUE_JWT_ADMIN_ROLES=service_role','-e','GOTRUE_JWT_AUD=authenticated',
  '-e','GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated','-e','GOTRUE_MAILER_AUTOCONFIRM=true','-e','GOTRUE_EXTERNAL_EMAIL_ENABLED=true','-e','GOTRUE_DISABLE_SIGNUP=false',
  'public.ecr.aws/supabase/gotrue:v2.188.1']);
 await waitFor(()=>command(['exec','lif626628_postgres','curl','--fail','--silent','--max-time','2','http://lif626628_auth:9999/health']).length>0);
 console.log('Auth schema ready; replaying source migrations with external cron disabled');
 const replay=spawn('python3',[dbRepo+'/scripts/replay-isolation-migrations.py','--container','lif626628_postgres','--output',output+'/replay'],{stdio:'inherit'});
 const code=await new Promise(r=>replay.on('close',r));
 if(code!==0) throw new Error('source_replay_failed_owned_fixture_retained_for_diagnosis');
 command(['run','-d','--name','lif626628_rest','--label',label,'--network',network,'--env-file',directory+'/rest.env',
  '-e','PGRST_DB_URI=postgresql://authenticator:lif626628-local-fixture@lif626628_postgres:5432/postgres','-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e','PGRST_JWT_AUD=authenticated',
  'public.ecr.aws/supabase/postgrest:v14.10']);
 await waitFor(()=>command(['exec','lif626628_postgres','curl','--fail','--silent','--max-time','2','http://lif626628_rest:3000/']).length>0);
 writeFileSync(output+'/environment.json',JSON.stringify({kind:'isolated-local-fixture',production:false,images:Object.fromEntries(names.map(name=>{const info=inspect(['inspect',name]);return[name,{image:info.Config.Image,image_id:info.Image}];}))},null,2)+'\n',{flag:'wx'});
 console.log('isolated Auth + Data API fixture ready');
} else throw new Error('usage: isolation-fixture.mjs start <database-repo> <new-evidence-directory> | stop');
