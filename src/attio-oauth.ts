import { connectionFetch } from "./connection-confirmation.js";
// Attio OAuth for LIFT's registered Attio app. Access tokens do not expire and
// Attio issues no refresh token; GET /v2/self identifies the token's workspace.

const AUTHORIZATION_ENDPOINT = "https://app.attio.com/authorize";
const TOKEN_ENDPOINT = "https://app.attio.com/oauth/token";
const SELF_ENDPOINT = "https://api.attio.com/v2/self";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** People/Companies records, attribute schema, research notes and the
 * meeting reads that detect booked meetings (sync-attio-meetings). */
export const ATTIO_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  "meeting:read",
  "note:read-write",
  "object_configuration:read-write",
  "record_permission:read-write",
]);

export interface AttioTokenIdentity {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  clientId: string;
  scopes: string[];
}

export function buildAttioAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  }
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function exchangeAttioAuthorizationCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString(),
  });
  if (!response.ok) {
    await response.text();
    throw new Error(`Attio token request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const token = payload.access_token;
  if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new Error("Attio token response did not include an access token");
  }
  return token;
}

export async function identifyAttioToken(options: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<AttioTokenIdentity> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(SELF_ENDPOINT, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${options.accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    await response.text();
    throw new Error(`Attio identify request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const text = (key: string) => typeof payload[key] === "string" ? (payload[key] as string).trim() : "";
  const identity = {
    workspaceId: text("workspace_id"),
    workspaceSlug: text("workspace_slug"),
    workspaceName: text("workspace_name"),
    clientId: text("client_id"),
    scopes: text("scope").split(/\s+/).filter(Boolean).sort(),
  };
  if (payload.active !== true || !UUID.test(identity.workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(identity.workspaceSlug)
    || identity.workspaceName.length < 1 || identity.workspaceName.length > 255) {
    throw new Error("Attio did not identify an active workspace token");
  }
  return identity;
}

export function missingAttioScopes(granted: readonly string[]): string[] {
  const set = new Set(granted);
  return ATTIO_REQUIRED_SCOPES.filter((scope) => !set.has(scope));
}
