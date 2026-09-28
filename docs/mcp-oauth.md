# Lifty chat authorization

The MCP endpoint and shared login/consent page are disabled until
`LIFTY_MCP_ENABLED=true`. `PUBLIC_BASE_URL` must be the canonical HTTPS origin;
the resource identifier is that origin plus `/mcp`, with no trailing slash.
`LIFTY_MCP_ALLOWED_ORIGINS` optionally adds comma-separated HTTPS browser origins.
Server-to-server calls do not need an Origin header. This setting does not
enable the Supabase OAuth server or dynamic registration.

The endpoint provides stateless Streamable HTTP using the official MCP SDK,
with JSON responses and no server session IDs. It authenticates every request
before interpreting JSON-RPC. `whoami` returns only `user_id` and is read-only.
Both `/.well-known/oauth-protected-resource` and the `/mcp` metadata suffix
advertise the configured Supabase Auth issuer. A rejected bearer token receives
401 and a `WWW-Authenticate` discovery challenge.

`/oauth/consent?authorization_id=...` uses the same login form and Auth transport
as `/cli/auth`. It retrieves the requesting client, return URL and scope from
Supabase Auth, displays explicit consent, and returns only the Auth-issued
authorization response to the registered HTTPS callback. It uses the same
endpoints as `getAuthorizationDetails`, `approveAuthorization` and
`denyAuthorization` in the pinned auth-js package, without loading a browser CDN
or persisting session tokens. The CLI loopback flow remains unchanged.

## Resource binding and enablement

The existing API checks remain mandatory: project issuer, `authenticated`
role/audience, signature/expiry and a fresh `lifty_session_active` RPC. MCP adds
an OAuth `client_id` and the exact `/mcp` resource in the JWT audience array.
An ordinary CLI token, an OAuth token with only `aud=authenticated`, and a token
for another MCP resource are rejected. No auth or session bypass is permitted.

Supabase's documented default OAuth token has `aud=authenticated`, which is
insufficient for MCP resource binding. Functions migration
`20260928193000_lif1097_oauth_mcp_audience.sql` supplies the custom access-token
hook `public.lifty_oauth_access_token_hook(jsonb)`. It preserves ordinary login
claims and stamps OAuth claims with the fixed audience array
`["authenticated", "https://lifty-api-staging-ox2h9.ondigitalocean.app/mcp"]`.
It never derives an audience from user metadata or a caller-supplied URL.
Its Auth URI is `pg-functions://postgres/public/lifty_oauth_access_token_hook`.
The migration installs the hook but does not enable it.

This policy reserves the shared project's OAuth server for Lifty. Every dynamic
client still needs the founder's consent; no operator registration step is
required per founder. OAuth tokens retain the founder's existing Data API/RLS
permissions because the `authenticated` audience is retained. OIDC scopes
describe identity disclosure and do not restrict database actions. The consent
page discloses the app's access to the account's permitted workspace actions.

Before enabling the connector:

1. Deploy the reviewed Functions migration through `production-database`, then
   this API revision through its owning deployment workflow.
2. Read back the current Auth hook configuration. Preserve any existing hook;
   if one is active, integrate the policy into it rather than replacing it.
3. Set the custom access-token hook above and Supabase OAuth server consent URL
   to the canonical origin plus `/oauth/consent`. Review dynamic registration
   enablement explicitly: it permits anyone to register a client, while access
   still requires founder consent. Record that decision in LIF-1097.
4. Enable the API feature. Complete a real authorization-code + S256 PKCE grant
   in the approved internal workspace. Verify issued and refreshed JWTs include
   both audiences, a real `client_id`/`session_id`, and pass the unchanged active
   session RPC. Revoke the grant and confirm its old access token is rejected.
5. Connect Claude and ChatGPT independently and call `whoami`; preserve only
   sanitized receipts. A synthetic JWT or mocked RPC proves the validation
   boundary, not hosted OAuth compatibility or either platform's login.

Rollback API exposure by disabling `LIFTY_MCP_ENABLED`; restore the previously
recorded Auth OAuth/hook configuration if the rollout enabled it. Never weaken
audience or session checks to compensate for an incompatible hosted token.

## Sources

- [Supabase OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)
- [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Custom access-token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
- [Current Auth token validation source](https://github.com/supabase/auth/blob/master/internal/tokens/service.go)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OpenAI connector authentication](https://developers.openai.com/plugins/build/auth)
