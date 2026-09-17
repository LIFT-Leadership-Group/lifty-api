import { z } from "zod";
import { UnipileTransport, type VerifiedTransport } from "./unipile-transport.js";
import { createUnipileV2Provider } from "./unipile-v2-provider.js";
import { unipileV2AuthState } from "./unipile-v2-state.js";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { LINKEDIN_POLICY, LinkedinConnectRequest, LinkedinConnectResult, LinkedinConnectionStatus, LinkedinFailureCode, LinkedinHealthStatus, LinkedinProfileId, LinkedinProfileUrl, LinkedinTimezone, type LinkedinConnectInput, type LinkedinStart, type LinkedinStatus } from "./linkedin-contracts.js";
import { createLinkedinProvider, type LinkedinIdentity, type LinkedinHealth } from "./linkedin-provider.js";
import type { UnipileProviderSettings } from "./unipile-provider.js";
import { sealLinkedinIntent, openLinkedinIntent, linkedinCallbackName, validLinkedinCallbackName } from "./linkedin-state.js";
import { linkedinFailure, mapLinkedinRpcError } from "./linkedin-errors.js";

export interface LinkedinConnectSettings extends UnipileProviderSettings {
  serverKey: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
}
interface RpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }
const Stored = z.object({
  transport: UnipileTransport.optional(),
  state: z.enum(["not_connected", "pending", "connecting", "connected", "disconnected", "failed", "revoked"]),
  workspace_ref: z.uuid(), timezone: LinkedinTimezone.nullish(),
  account_id: LinkedinProfileId.nullish(), connection_ref: z.uuid().nullish(), intent_ref: z.uuid().nullish(),
  profile_id: LinkedinProfileId.nullish(), profile_url: LinkedinProfileUrl.nullish(), display_name: z.string().max(401).nullish(),
  expires_at: z.string().optional(), failure_code: LinkedinFailureCode.nullish(), outbound_enabled: z.boolean().optional(), health_status: LinkedinHealthStatus.nullish(),
});
const Intent = z.object({
  transport: UnipileTransport.optional(), authorization_account_id: z.string().nullish(), authorization_received: z.boolean().optional(),
  state: z.enum(["pending", "issuing", "ready", "completed", "failed"]), intent_ref: z.uuid(), workspace_ref: z.uuid(),
  expires_at: z.string(), account_id: LinkedinProfileId.nullable(), profile_id: LinkedinProfileId.nullable(),
  hosted_url: z.url().nullable(), timezone: LinkedinTimezone,
});
const callbackBody = z.object({ status: z.enum(["CREATION_SUCCESS", "RECONNECTED"]), account_id: LinkedinProfileId, name: z.string() });
const identityMismatch = (error: unknown) => error instanceof PublicError && error.code === "UNIPILE_LINKEDIN_IDENTITY_MISMATCH";
const providerPending = (error: unknown) => error instanceof PublicError && ["UNIPILE_LINKEDIN_UNAVAILABLE", "UNIPILE_LINKEDIN_ACCOUNT_NOT_FOUND", "UNIPILE_LINKEDIN_ACCOUNT_UNHEALTHY"].includes(error.code);

export function createLinkedinConnectOperations(settings: LinkedinConnectSettings) {
  if (settings.serverKey.length < 32) throw new Error("Invalid LinkedIn server key.");
  const provider = createLinkedinProvider(settings);
  const v2=settings.v2 ? createUnipileV2Provider({...settings.v2,...(settings.fetchImpl ? {fetchImpl:settings.fetchImpl} : {}),...(settings.timeoutMs ? {timeoutMs:settings.timeoutMs} : {})}) : null;
  function requireV2(){if(!v2)linkedinFailure("LINKEDIN_CONNECTION_UNAVAILABLE",503);return v2;}
  async function readIdentity(accountId:string,profileId:string|null|undefined,transport?:UnipileTransport):Promise<LinkedinIdentity & {verifiedTransport?:VerifiedTransport}> {
    if(transport?.api_version!=="v2")return provider.readIdentity(accountId,profileId);
    try {return await requireV2().readLinkedinIdentity(transport.account_id ?? accountId,transport,profileId);}
    catch(error){
      if(error instanceof PublicError)throw new PublicError({status:error.status,code:error.code.replace("UNIPILE_","UNIPILE_LINKEDIN_"),message:error.message});
      throw error;
    }
  }
  const fetchImpl = settings.fetchImpl ?? fetch;
  async function rpc(operation: string, payload: Record<string, unknown>, session?: AuthSession, name: "lifty_linkedin_connection" | "lifty_linkedin_callback_hint" = "lifty_linkedin_connection"): Promise<unknown> {
    const args = { p_server_key: settings.serverKey, p_operation: operation, p_payload: payload };
    try {
      if (session) {
        const { data, error } = await (session.client as RpcClient).rpc(name, args);
        if (error) mapLinkedinRpcError(error);
        return data;
      }
      // Browser callbacks have only the narrowly scoped capability and durable
      // intent. SQL rechecks the issuer membership; there is no service-role key.
      const response = await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { apikey: settings.publishableKey, "content-type": "application/json" }, body: JSON.stringify(args),
      });
      const data: unknown = await response.json();
      if (!response.ok) mapLinkedinRpcError(data);
      return data;
    } catch (error) { mapLinkedinRpcError(error); }
  }
  function profile(value: z.infer<typeof Stored>) {
    return { provider: "unipile" as const, channel: "linkedin" as const, workspace_ref: value.workspace_ref,
      profile_id: value.profile_id ?? null, profile_url: value.profile_url ?? null, display_name: value.display_name ?? null,
      timezone: value.timezone, account_use: "personal" as const, other_automation: false as const, policy: LINKEDIN_POLICY,
      health_status: value.health_status ?? "unknown", sending_enabled: value.state === "connected" && value.health_status === "running" && value.outbound_enabled === true };
  }
  async function readStored(session: AuthSession, workspace: string) {
    const stored = Stored.parse(await rpc("status", { workspace }, session));
    if (z.uuid().safeParse(workspace).success && stored.workspace_ref !== workspace) linkedinFailure("LINKEDIN_CONNECTION_UNAVAILABLE");
    return stored;
  }
  async function complete(intentRef: string, identity: LinkedinIdentity & {verifiedTransport?:VerifiedTransport}) {
    await rpc("complete", { intent_ref: intentRef, account_id: identity.accountId, profile_id: identity.profileId,
      ...(identity.verifiedTransport ? {verified_transport:identity.verifiedTransport} : {}),
      ...(identity.profileUrl ? { profile_url: identity.profileUrl } : {}), ...(identity.displayName ? { display_name: identity.displayName } : {}) });
  }
  async function refreshHealth(session: AuthSession, workspace: string, value: z.infer<typeof Stored>) {
    if (!value.account_id || !value.profile_id || !value.connection_ref) linkedinFailure("LINKEDIN_CONNECTION_UNAVAILABLE");
    let status: LinkedinHealth = "unknown";
    try { status = (await readIdentity(value.account_id, value.profile_id,value.transport)).healthStatus; }
    catch (error) {
      // A timeout/provider outage is not evidence of revoked credentials. Do
      // not write unknown health and disconnect a previously healthy grant.
      if (error instanceof PublicError && error.code === "UNIPILE_LINKEDIN_UNAVAILABLE") throw error;
      if (!identityMismatch(error) && !providerPending(error)) throw error;
      status = error instanceof PublicError && error.code === "UNIPILE_LINKEDIN_ACCOUNT_NOT_FOUND" ? "disconnected" :
        error instanceof PublicError && error.code === "UNIPILE_LINKEDIN_ACCOUNT_UNHEALTHY" ? "credentials" : "unknown";
    }
    await rpc("health", { workspace, connection_ref: value.connection_ref, account_id: value.account_id, profile_id: value.profile_id, status,
      ...(value.transport ? {transport_generation:value.transport.generation,transport_api_version:value.transport.api_version} : {}) }, session);
    return readStored(session, workspace);
  }
  async function status(session: AuthSession, workspace: string, attemptRef?: string): Promise<LinkedinStatus> {
    let value = await readStored(session, workspace);
    let completed = false;
    if (value.state === "pending" && value.intent_ref && (!attemptRef || value.intent_ref === attemptRef)) {
      const pendingIntent=value.transport?.api_version==="v2" ? await readIntent(value.intent_ref) : null;
      if(pendingIntent && (pendingIntent.workspace_ref!==value.workspace_ref || pendingIntent.transport?.api_version!=="v2"))linkedinFailure("LINKEDIN_CALLBACK_INVALID",403);
      const hint=pendingIntent ? {account_id:pendingIntent.authorization_received ? pendingIntent.authorization_account_id ?? null : null}
        : z.object({ workspace_ref: z.literal(value.workspace_ref), intent_ref: z.literal(value.intent_ref), account_id: LinkedinProfileId.nullable() })
          .parse(await rpc("read", { workspace_ref: value.workspace_ref, intent_ref: value.intent_ref }, session, "lifty_linkedin_callback_hint"));
      if (hint.account_id) {
        try {
          if(pendingIntent?.transport?.account_id && pendingIntent.transport.account_id!==hint.account_id)linkedinFailure("LINKEDIN_IDENTITY_MISMATCH",409);
          const identity = await readIdentity(hint.account_id, pendingIntent ? pendingIntent.profile_id : value.profile_id,pendingIntent?.transport);
          if (identity.healthy) { await complete(value.intent_ref, identity); completed = true; }
        } catch (error) {
          if (error instanceof PublicError && error.code === "UNIPILE_LINKEDIN_UNAVAILABLE") throw error;
          if (identityMismatch(error)) await rpc("fail", { intent_ref: value.intent_ref, failure_code: "identity_mismatch" });
          else if (!providerPending(error)) throw error;
        }
        // A fresh authorized read observes membership revocation and disconnect
        // races after hint verification. Completion never activates campaigns.
        value = await readStored(session, workspace);
      }
    }
    if (value.state === "connected" && !completed) value = await refreshHealth(session, workspace, value);
    if (value.state === "not_connected") return LinkedinConnectionStatus.parse({ provider: "unipile", channel: "linkedin", workspace_ref: value.workspace_ref, status: "not_connected" });
    const state = value.state === "revoked" || value.state === "connecting" || (value.state === "connected" && value.health_status !== "running") ? "disconnected" : value.state;
    return LinkedinConnectionStatus.parse({ ...profile(value), status: state, connection_ref: value.connection_ref ?? null, intent_ref: value.intent_ref ?? null, failure_code: value.failure_code ?? null });
  }
  async function start(session: AuthSession, input: LinkedinConnectInput): Promise<LinkedinStart> {
    const parsed = LinkedinConnectRequest.parse(input);
    let value = Stored.parse(await rpc("start", parsed, session));
    if (z.uuid().safeParse(parsed.workspace).success && value.workspace_ref !== parsed.workspace) linkedinFailure("LINKEDIN_CONNECTION_UNAVAILABLE");
    if (value.state === "connected") {
      value = await refreshHealth(session, parsed.workspace, value);
      if (value.state === "connected" && value.health_status === "running") return LinkedinConnectResult.parse({ ...profile(value), status: "connected", connection_ref: value.connection_ref });
      await rpc("disconnect", { workspace: parsed.workspace, confirm: true }, session);
      value = Stored.parse(await rpc("start", parsed, session));
    }
    if (!value.intent_ref || !value.expires_at) linkedinFailure("LINKEDIN_CONNECTION_UNAVAILABLE");
    const seconds = Math.min(1800, Math.floor((Date.parse(value.expires_at) - Date.now()) / 1000));
    if (!Number.isFinite(seconds) || seconds <= 0) linkedinFailure("LINKEDIN_INTENT_EXPIRED", 410);
    const state = sealLinkedinIntent(value.intent_ref, settings.serverKey);
    return LinkedinConnectResult.parse({ ...profile(value), status: "pending", sending_enabled: false, intent_ref: value.intent_ref,
      connect_url: `${settings.publicBaseUrl}/unipile/linkedin/start?intent=${encodeURIComponent(state)}`, expires_in_seconds: seconds,
      expires_at: value.expires_at });
  }
  function open(state: string) {
    try { return openLinkedinIntent(state, settings.serverKey); }
    catch { linkedinFailure("LINKEDIN_INTENT_EXPIRED", 410); }
  }
  async function readIntent(id: string) {
    const intent = Intent.parse(await rpc("intent", { intent_ref: id }));
    if (intent.intent_ref !== id) linkedinFailure("LINKEDIN_CALLBACK_INVALID", 403);
    return intent;
  }
  async function authorize(state: string): Promise<string> {
    const id = open(state), intent = await readIntent(id);
    if (intent.state === "ready" && intent.hosted_url) return intent.hosted_url;
    if (intent.state === "failed" || intent.state === "completed") linkedinFailure("LINKEDIN_INTENT_EXPIRED", 410);
    const claim = z.object({ claimed: z.boolean() }).parse(await rpc("issue_link", { intent_ref: id }));
    if (!claim.claimed) linkedinFailure("LINKEDIN_LINK_PENDING", 409, "A LinkedIn connection link is being prepared. Open it again shortly.");
    let phase: "create" | "save" = "create";
    try {
      let url:string;
      if(intent.transport?.api_version==="v2") {
        const authState=unipileV2AuthState("linkedin",id,settings.serverKey);
        await rpc("auth_state",{intent_ref:id,state:authState});
        url=await requireV2().createLink({channel:"linkedin",state:authState,transport:intent.transport,
          redirectUri:`${settings.publicBaseUrl}/unipile/v2/linkedin/return?intent=${encodeURIComponent(state)}`,
          expiresAt:new Date(intent.expires_at).toISOString()});
      } else url = await provider.createLink({ correlation: linkedinCallbackName(id, settings.serverKey),
        notifyUrl: `${settings.publicBaseUrl}/unipile/linkedin/callback?intent=${encodeURIComponent(state)}`,
        expiresAt: new Date(intent.expires_at).toISOString(), reconnectId: intent.account_id });
      phase = "save"; await rpc("save_link", { intent_ref: id, url }); return url;
    } catch (error) {
      try { await rpc("fail", { intent_ref: id, failure_code: "link_failed" }); } catch { /* Preserve the original safe failure; do not create another provider link. */ }
      if (phase === "create" && error instanceof PublicError && error.code.startsWith("UNIPILE_HOSTED_")) {
        throw new PublicError({ status: error.status, code: error.code.replace("UNIPILE_", "UNIPILE_LINKEDIN_"), message: error.message });
      }
      if (error instanceof PublicError && (error.status === 401 || error.status === 403 || (phase === "create" && error.code.startsWith("UNIPILE_LINKEDIN_HOSTED_")))) throw error;
      linkedinFailure(phase === "save" ? "LINKEDIN_LINK_SAVE_FAILED" : "LINKEDIN_LINK_CREATE_FAILED");
    }
  }
  async function callback(state: string, body: unknown): Promise<void> {
    const id = open(state), parsed = callbackBody.safeParse(body);
    if (!parsed.success || !validLinkedinCallbackName(id, parsed.data.name, settings.serverKey)) linkedinFailure("LINKEDIN_CALLBACK_INVALID", 403);
    const intent = await readIntent(id);
    if(intent.transport?.api_version==="v2")linkedinFailure("LINKEDIN_CALLBACK_INVALID",403);
    if (!["ready", "completed"].includes(intent.state)) linkedinFailure("LINKEDIN_INTENT_EXPIRED", 410);
    if (intent.account_id && intent.account_id !== parsed.data.account_id) linkedinFailure("LINKEDIN_IDENTITY_MISMATCH", 409);
    await rpc("record", { workspace_ref: intent.workspace_ref, intent_ref: id, account_id: parsed.data.account_id, callback_name: parsed.data.name }, undefined, "lifty_linkedin_callback_hint");
    let identity: LinkedinIdentity;
    try { identity = await provider.readIdentity(parsed.data.account_id, intent.profile_id); }
    catch (error) {
      if (identityMismatch(error)) await rpc("fail", { intent_ref: id, failure_code: "identity_mismatch" });
      throw error;
    }
    if (!identity.healthy) linkedinFailure("LINKEDIN_PROVIDER_NOT_READY", 503, "LinkedIn is still connecting or needs attention. Check status after resolving the provider prompt.");
    await complete(id, identity);
  }
  async function disconnect(session: AuthSession, workspace: string): Promise<LinkedinStatus> {
    await rpc("disconnect", { workspace, confirm: true }, session);
    return status(session, workspace);
  }
  async function v2Return(state:string):Promise<void> {
    const intent=await readIntent(open(state));
    if(intent.transport?.api_version!=="v2" || !["ready","completed"].includes(intent.state))linkedinFailure("LINKEDIN_CALLBACK_INVALID",403);
  }
  return { start, status, authorize, callback, disconnect, v2Return };
}
