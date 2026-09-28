/**
 * Uses the same Auth endpoints as auth-js getAuthorizationDetails,
 * approveAuthorization and denyAuthorization (pinned @supabase/auth-js).
 * The shared login deliberately keeps tokens in memory without a CDN script.
 */
export const oauthConsentBrowserScript = `
    function oauthRedirect(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_redirect");
      // Only an Auth response supplies this URL; the page's query never does.
      session = null;
      window.location.assign(url.href);
    }
    async function getAuthorizationDetails() {
      return authRequest("/auth/v1/oauth/authorizations/" + encodeURIComponent(config.authorizationId),
        { method: "GET", accessToken: session.access_token });
    }
    async function decideAuthorization(action) {
      if (!session || byId("approve").disabled) return;
      byId("approve").disabled = true;
      byId("deny").disabled = true;
      byId("approve-status").textContent = "Returning to your app...";
      try {
        const result = await authRequest("/auth/v1/oauth/authorizations/" + encodeURIComponent(config.authorizationId) + "/consent",
          { body: { action }, accessToken: session.access_token });
        oauthRedirect(result.redirect_url);
      } catch {
        // A timeout may already have consumed this authorization. Never retry
        // consent automatically or display the upstream error/token material.
        session = null;
        byId("approve-status").textContent = "We couldn't confirm the authorization. Return to your app and reconnect Lifty if needed.";
      }
    }
    const approveAuthorization = () => decideAuthorization("approve");
    const denyAuthorization = () => decideAuthorization("deny");
    async function showOAuthConsent() {
      byId("approve").disabled = true;
      byId("deny").disabled = true;
      try {
        const details = await getAuthorizationDetails();
        if (details.redirect_url) { oauthRedirect(details.redirect_url); return; }
        const redirect = new URL(details.redirect_uri);
        if (redirect.protocol !== "https:" || redirect.username || redirect.password
          || typeof details.client?.name !== "string" || typeof details.scope !== "string") throw new Error("invalid_details");
        byId("client-name").textContent = details.client.name;
        byId("client-redirect").textContent = details.redirect_uri;
        byId("client-scopes").textContent = details.scope || "Basic account access";
        byId("approve").disabled = false;
        byId("deny").disabled = false;
        authCard.hidden = true;
        approveCard.hidden = false;
      } catch {
        session = null;
        authCard.hidden = false;
        approveCard.hidden = true;
        byId("auth-error").textContent = "This authorization is unavailable or expired. Return to your app and reconnect Lifty.";
        byId("auth-error").hidden = false;
      }
    }
`;
