import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { getVerifiedSessionToken } from "./supabase-auth.js";
import {
  EmailAccountsRequest, EmailAccountsResult, EmailAccountConnectRequest, EmailAccountConnectResult,
  EmailAccountStatusRequest, EmailAccountStatusResult, type EmailAccountsInput,
  type EmailAccountConnectInput, type EmailAccountStatusInput,
} from "./email-accounts-contracts.js";

const unavailable = () => new PublicError({status:502,code:"EMAIL_ACCOUNTS_UNAVAILABLE",message:"Email account setup could not be verified. Keep the same attempt reference and retry status shortly."});
const upstreamErrors = {
  unauthorized:{status:401,code:"UNAUTHORIZED",message:"Sign in to Lifty before managing email accounts."},
  invalid_request:{status:400,code:"EMAIL_ACCOUNTS_INVALID_REQUEST",message:"Choose a workspace and provide the requested email account fields."},
  workspace_forbidden:{status:403,code:"EMAIL_WORKSPACE_FORBIDDEN",message:"Choose a workspace you belong to."},
  sender_unavailable:{status:409,code:"EMAIL_SENDER_UNAVAILABLE",message:"Choose an available sender from this workspace's email accounts."},
  invalid_attempt:{status:400,code:"EMAIL_ATTEMPT_INVALID",message:"This connection attempt is invalid or expired. Check the workspace's email accounts before requesting a new link."},
} as const;
const claimsSchema = z.object({v:z.literal(1),workspace_id:z.uuid(),workspace_slug:EmailAccountsRequest.shape.workspace,
  sender_id:z.uuid(),channel:z.literal("email"),identity:z.email().max(254),iat:z.number().int().nonnegative(),
  exp:z.number().int().nonnegative(),nonce:z.uuid(),issuer_user_id:z.uuid()}).strict();

// This checks response correlation, not the HMAC. The authenticated Edge owner
// verifies signatures and membership. No browser-provided destination is fetched.
function claims(attempt:string) {
  try {
    const encoded=attempt.split(".")[0]!;
    const bytes=Buffer.from(encoded,"base64url");
    if(bytes.toString("base64url")!==encoded)throw Error();
    const value=claimsSchema.parse(JSON.parse(bytes.toString("utf8")));
    if(value.exp-value.iat!==3600 || value.identity!==value.identity.toLowerCase())throw Error();
    return value;
  } catch {throw unavailable();}
}
function matchesWorkspace(input:string, id:string, slug:string) {
  return z.uuid().safeParse(input).success ? input.toLowerCase()===id.toLowerCase() : input===slug;
}

export function createEmailAccountOperations(settings:{supabaseUrl:string;publishableKey:string;fetchImpl?:typeof fetch;now?:()=>Date}) {
  const base=new URL(settings.supabaseUrl);
  if(base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)
    || (base.protocol!=="https:" && !(base.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(base.hostname)))) {
    throw new Error("Email accounts require a trusted Supabase origin.");
  }
  const connectUrl=new URL("/functions/v1/lift-unipile-connect",base);
  const fetchImpl=settings.fetchImpl??fetch, now=settings.now??(()=>new Date());
  async function call(session:AuthSession, path:"accounts"|"connect"|"connect/status", input:Record<string,unknown>) {
    const token=getVerifiedSessionToken(session);
    if(!token)throw new PublicError(upstreamErrors.unauthorized);
    const url=new URL(`${connectUrl.pathname}/member/${path}`,base);
    const read=path==="accounts";
    if(read)url.searchParams.set("workspace",String(input.workspace));
    let response:Response,body:unknown;
    try {
      response=await fetchImpl(url,{method:read?"GET":"POST",redirect:"error",signal:AbortSignal.timeout(15000),
        headers:{authorization:`Bearer ${token}`,apikey:settings.publishableKey,accept:"application/json",...(read?{}:{"content-type":"application/json"})},
        ...(read?{}:{body:JSON.stringify(input)})});
      const text=await response.text();
      if(text.length>2_000_000)throw Error();
      body=JSON.parse(text);
    }catch{throw unavailable();}
    if(!response.ok) {
      const error=z.object({error:z.string()}).strict().safeParse(body);
      const known=error.success && Object.hasOwn(upstreamErrors,error.data.error)
        ? upstreamErrors[error.data.error as keyof typeof upstreamErrors] : null;
      if(known && response.status===known.status)throw new PublicError(known);
      throw unavailable();
    }
    return body;
  }
  return {
    async accounts(session:AuthSession,input:EmailAccountsInput) {
      const request=EmailAccountsRequest.parse(input);
      const result=EmailAccountsResult.safeParse(await call(session,"accounts",request));
      if(!result.success || !matchesWorkspace(request.workspace,result.data.workspace_ref,result.data.workspace_slug))throw unavailable();
      return result.data;
    },
    async connect(session:AuthSession,input:EmailAccountConnectInput) {
      const request=EmailAccountConnectRequest.parse(input);
      const result=EmailAccountConnectResult.safeParse(await call(session,"connect",request));
      if(!result.success)throw unavailable();
      const data=result.data, attempt=claims(data.attempt_ref), url=new URL(data.connection_url);
      const expected=new URL(connectUrl);expected.searchParams.set("t",data.attempt_ref);
      if(url.toString()!==expected.toString() || data.connection_url!==expected.toString()
        || attempt.issuer_user_id!==session.userId || !matchesWorkspace(request.workspace,attempt.workspace_id,attempt.workspace_slug)
        || attempt.workspace_id!==data.workspace_ref || attempt.sender_id!==request.sender_ref || data.sender_ref!==request.sender_ref
        || attempt.identity!==request.email || data.email!==request.email || attempt.exp*1000!==Date.parse(data.expires_at)
        || attempt.exp*1000<=now().getTime() || attempt.iat*1000>now().getTime()+60000)throw unavailable();
      return data;
    },
    async status(session:AuthSession,input:EmailAccountStatusInput) {
      const request=EmailAccountStatusRequest.parse(input);
      // Let Edge decide expiry and authorization. Only a matching receipt can pass through.
      const result=EmailAccountStatusResult.safeParse(await call(session,"connect/status",request));
      if(!result.success)throw unavailable();
      const data=result.data,attempt=claims(request.attempt_ref);
      if(attempt.issuer_user_id!==session.userId || !matchesWorkspace(request.workspace,attempt.workspace_id,attempt.workspace_slug)
        || attempt.workspace_id!==data.workspace_ref || attempt.sender_id!==data.sender_ref || attempt.identity!==data.email)throw unavailable();
      return data;
    },
  };
}
