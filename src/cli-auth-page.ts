import { authBrowserScript } from "./auth-browser.js";
import { renderLiftyPage } from "./lifty-brand.js";
import { oauthConsentBrowserScript } from "./oauth-consent-browser.js";

const styles = `
#auth-form{margin-top:26px}
#auth-error{margin:0 0 14px;font-size:14px}
.aside{display:grid;gap:6px;margin-top:22px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.details{display:grid;gap:8px;margin-top:18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.details span{color:var(--ink)}
#approve-status{margin-top:16px;color:var(--muted);font-size:14px}
#approve-status.error{color:var(--danger)}
.actions{display:flex;gap:10px;margin-top:22px}
.actions button{flex:1}
`;

export type CliAuthPageOptions = {
  supabaseUrl: string;
  publishableKey: string;
  scriptNonce: string;
} & ({ state: string; port: number; authorizationId?: never }
  | { authorizationId: string; state?: never; port?: never });

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/**
 * Shared hosted login for CLI and OAuth. Tokens stay in JS memory. OAuth
 * returns only the Auth-issued authorization code to the registered client.
 */
export function renderCliAuthPage(options: CliAuthPageOptions): string {
  const oauth = options.authorizationId !== undefined;
  const configuration = jsonForInlineScript({
    supabaseUrl: options.supabaseUrl.replace(/\/$/, ""),
    publishableKey: options.publishableKey,
    ...(oauth ? { authorizationId: options.authorizationId } : {
      state: options.state, callbackUrl: `http://127.0.0.1:${options.port}/callback`,
    }),
  });

  return renderLiftyPage({
    title: oauth ? "Connect Lifty" : "Authorize the Lifty CLI",
    favicon: true,
    styles,
    content: `
    <section id="auth-card">
      <h1 id="auth-title">Sign in to Lifty</h1>
      <p class="intro" id="auth-description">${oauth ? "Sign in to connect Lifty to your app." : "Sign in to authorize the CLI on this machine."}</p>
      <form id="auth-form">
        <label>Email<input id="email" type="email" autocomplete="email" required></label>
        <label>Password<input id="password" type="password" autocomplete="current-password" required></label>
        <p id="auth-error" class="error" role="alert" hidden></p>
        <button class="primary block" id="submit" type="submit">Sign in</button>
      </form>
      <div class="aside">
        <p><a href="/auth/password-reset" target="_blank" rel="noopener noreferrer">Forgot your password?</a></p>
        <p><span id="mode-prompt">New to Lifty?</span> <button class="link" id="switch-mode" type="button">Create account</button></p>
      </div>
    </section>
    <section id="approve-card" hidden>
      <h1>${oauth ? 'Connect <span id="client-name"></span> to Lifty' : "Authorize the Lifty CLI on this machine"}</h1>
      <p class="intro">${oauth ? "This app" : "The CLI"} will act as <strong id="account-email"></strong> until you sign out or revoke access.</p>
      ${oauth ? '<div class="details"><p>It can access your Lifty workspace and perform the actions your account permits.</p><p>Requested account information: <span id="client-scopes"></span></p><p>Return address: <span id="client-redirect"></span></p></div>' : ""}
      <p id="approve-status" role="status"></p>
      <div class="actions">
        <button class="primary" id="approve" type="button">Approve</button>
        <button id="deny" type="button">Deny</button>
      </div>
    </section>
    <section id="done-card" hidden>
      <h1 id="done-title"></h1>
      <p class="intro" id="done-message"></p>
    </section>`,
    scripts: `
  <script nonce="${options.scriptNonce}">
    "use strict";
    const config = ${configuration};
    let mode = "sign-in";
    let session = null;
    const byId = (id) => document.getElementById(id);
    const authCard = byId("auth-card");
    const approveCard = byId("approve-card");
    const doneCard = byId("done-card");

    ${authBrowserScript}
    ${oauth ? oauthConsentBrowserScript : ""}

    function setMode(nextMode) {
      mode = nextMode;
      const creating = mode === "create";
      byId("auth-title").textContent = creating ? "Create your Lifty account" : "Sign in to Lifty";
      byId("auth-description").textContent = config.authorizationId
        ? (creating ? "Create an account, then connect Lifty to your app." : "Sign in to connect Lifty to your app.")
        : (creating ? "Create an account, then authorize the CLI on this machine." : "Sign in to authorize the CLI on this machine.");
      byId("submit").textContent = creating ? "Create account" : "Sign in";
      byId("password").autocomplete = creating ? "new-password" : "current-password";
      byId("password").minLength = creating ? 8 : 0;
      byId("mode-prompt").textContent = creating ? "Already have an account?" : "New to Lifty?";
      byId("switch-mode").textContent = creating ? "Sign in" : "Create account";
      byId("auth-error").hidden = true;
    }

    byId("switch-mode").addEventListener("click", () => setMode(mode === "sign-in" ? "create" : "sign-in"));
    byId("auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (byId("submit").disabled) return;
      const selectedMode = mode;
      const submit = byId("submit");
      const error = byId("auth-error");
      error.hidden = true;
      submit.disabled = true;
      const email = byId("email").value;
      const password = byId("password").value;
      const endpoint = selectedMode === "sign-in" ? "/auth/v1/token?grant_type=password" : "/auth/v1/signup";
      try {
        const payload = await authRequest(endpoint, { body: { email, password } });
        const candidate = payload.session || payload;
        if (!candidate.access_token || !candidate.refresh_token) {
          error.textContent = config.authorizationId ? "Check your email to confirm the account, then connect Lifty again from your app." : "Check your email to confirm the account, then run lifty login again.";
          error.hidden = false;
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        session = {
          access_token: candidate.access_token,
          refresh_token: candidate.refresh_token,
          expires_at: Number(candidate.expires_at) || now + Number(candidate.expires_in || 0)
        };
        byId("account-email").textContent = email;
        if (config.authorizationId) { await showOAuthConsent(); return; }
        authCard.hidden = true;
        approveCard.hidden = false;
      } catch (caught) {
        error.textContent = safeAuthMessage(caught, selectedMode);
        error.hidden = false;
      } finally {
        byId("password").value = "";
        submit.disabled = false;
      }
    });

    byId("approve").addEventListener("click", async () => {
      if (config.authorizationId) { await approveAuthorization(); return; }
      if (!session) return;
      const approve = byId("approve");
      const status = byId("approve-status");
      approve.disabled = true;
      status.textContent = "Authorizing...";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(config.callbackUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: config.state, ...session }),
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer"
        });
        if (!response.ok) throw new Error("callback_rejected");
        session = null;
        approveCard.hidden = true;
        doneCard.hidden = false;
        byId("done-title").textContent = "You're authenticated";
        byId("done-message").textContent = "Return to your agent to continue. You can close this tab.";
      } catch {
        status.textContent = "The browser couldn't confirm whether the CLI signed in. Return to your agent and ask it to run lifty whoami. If signed in, continue; otherwise run lifty login again and retry in Chrome.";
        status.className = "error";
        approve.disabled = false;
      } finally {
        clearTimeout(timer);
      }
    });

    byId("deny").addEventListener("click", async () => {
      if (config.authorizationId) { await denyAuthorization(); return; }
      session = null;
      approveCard.hidden = true;
      doneCard.hidden = false;
      byId("done-title").textContent = "Authorization cancelled";
      byId("done-message").textContent = "Nothing was sent. Run lifty login again when you are ready.";
    });
  </script>`,
  });
}
