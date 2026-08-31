export interface CliAuthPageOptions {
  supabaseUrl: string;
  publishableKey: string;
  state: string;
  port: number;
  scriptNonce: string;
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/**
 * Minimal hosted login surface for `lifty login`. Session tokens stay in JS
 * memory and leave the page only in the JSON body sent to 127.0.0.1.
 */
export function renderCliAuthPage(options: CliAuthPageOptions): string {
  const configuration = jsonForInlineScript({
    supabaseUrl: options.supabaseUrl.replace(/\/$/, ""),
    publishableKey: options.publishableKey,
    state: options.state,
    callbackUrl: `http://127.0.0.1:${options.port}/callback`,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Authorize the LIFTY CLI</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0b0d10; color: #f4f4f5; }
    main { width: min(92vw, 420px); }
    .brand { letter-spacing: .18em; font-size: .82rem; font-weight: 800; margin: 0 0 1.25rem; }
    .card { border: 1px solid #2a2e35; border-radius: 16px; padding: 1.5rem; background: #14171c; box-shadow: 0 18px 60px #0008; }
    h1 { margin: 0 0 .5rem; font-size: 1.45rem; }
    p { color: #a9afb9; line-height: 1.5; }
    label { display: grid; gap: .45rem; margin: 1rem 0; font-size: .9rem; }
    input { font: inherit; padding: .75rem; border-radius: 9px; border: 1px solid #373d47; background: #0d1014; color: inherit; }
    button { font: inherit; font-weight: 700; padding: .72rem 1rem; border-radius: 9px; border: 1px solid #596273; cursor: pointer; }
    button.primary { background: #f4f4f5; color: #111318; border-color: #f4f4f5; }
    button.link { border: 0; padding: 0; background: transparent; color: #c7cbd2; text-decoration: underline; }
    .actions { display: flex; gap: .75rem; margin-top: 1.25rem; }
    .error { color: #fda4af; }
    .success { color: #86efac; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <p class="brand">LIFTY</p>
    <section class="card" id="auth-card">
      <h1 id="auth-title">Sign in to LIFTY</h1>
      <p id="auth-description">Sign in to authorize the CLI on this machine.</p>
      <form id="auth-form">
        <label>Email<input id="email" type="email" autocomplete="email" required></label>
        <label>Password<input id="password" type="password" autocomplete="current-password" required></label>
        <p id="auth-error" class="error" role="alert" hidden></p>
        <button class="primary" id="submit" type="submit">Sign in</button>
      </form>
      <p><span id="mode-prompt">New to LIFTY?</span> <button class="link" id="switch-mode" type="button">Create account</button></p>
    </section>
    <section class="card" id="approve-card" hidden>
      <h1>Authorize the LIFTY CLI on this machine</h1>
      <p>The CLI will act as <strong id="account-email"></strong> until you sign out or revoke access.</p>
      <p id="approve-status" role="status"></p>
      <div class="actions">
        <button class="primary" id="approve" type="button">Approve</button>
        <button id="deny" type="button">Deny</button>
      </div>
    </section>
    <section class="card" id="done-card" hidden>
      <h1 id="done-title"></h1>
      <p id="done-message"></p>
    </section>
  </main>
  <script nonce="${options.scriptNonce}">
    "use strict";
    const config = ${configuration};
    let mode = "sign-in";
    let session = null;
    const byId = (id) => document.getElementById(id);
    const authCard = byId("auth-card");
    const approveCard = byId("approve-card");
    const doneCard = byId("done-card");

    function safeAuthMessage(payload, selectedMode) {
      const marker = String(payload && (payload.code || payload.error_code || payload.msg || payload.message) || "");
      if (/signup.*disabled|signups?.*not.*allowed/i.test(marker)) return "New accounts are invite-only. Ask LIFT for an invite, then sign in here.";
      if (/already.*registered/i.test(marker)) return "That email already has an account. Sign in instead.";
      if (/invalid.*login|invalid.*credential/i.test(marker)) return "The email or password is incorrect.";
      return selectedMode === "sign-in" ? "We couldn't sign you in. Try again." : "We couldn't create the account. Try again.";
    }

    function setMode(nextMode) {
      mode = nextMode;
      const creating = mode === "create";
      byId("auth-title").textContent = creating ? "Create your LIFTY account" : "Sign in to LIFTY";
      byId("auth-description").textContent = creating ? "Create an account, then authorize the CLI on this machine." : "Sign in to authorize the CLI on this machine.";
      byId("submit").textContent = creating ? "Create account" : "Sign in";
      byId("password").autocomplete = creating ? "new-password" : "current-password";
      byId("password").minLength = creating ? 8 : 0;
      byId("mode-prompt").textContent = creating ? "Already have an account?" : "New to LIFTY?";
      byId("switch-mode").textContent = creating ? "Sign in" : "Create account";
      byId("auth-error").hidden = true;
    }

    byId("switch-mode").addEventListener("click", () => setMode(mode === "sign-in" ? "create" : "sign-in"));
    byId("auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = byId("submit");
      const error = byId("auth-error");
      error.hidden = true;
      submit.disabled = true;
      const email = byId("email").value;
      const password = byId("password").value;
      const endpoint = mode === "sign-in" ? "/auth/v1/token?grant_type=password" : "/auth/v1/signup";
      try {
        const response = await fetch(config.supabaseUrl + endpoint, {
          method: "POST",
          headers: { "apikey": config.publishableKey, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw { payload };
        const candidate = payload.session || payload;
        if (!candidate.access_token || !candidate.refresh_token) {
          error.textContent = "Check your email to confirm the account, then run lifty login again.";
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
        authCard.hidden = true;
        approveCard.hidden = false;
      } catch (caught) {
        error.textContent = safeAuthMessage(caught && caught.payload, mode);
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });

    byId("approve").addEventListener("click", async () => {
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
        byId("done-message").textContent = "Return to your terminal. You can close this tab.";
      } catch {
        status.textContent = "We couldn't reach the CLI. Keep lifty login running and try again in a Chromium browser.";
        status.className = "error";
        approve.disabled = false;
      } finally {
        clearTimeout(timer);
      }
    });

    byId("deny").addEventListener("click", () => {
      session = null;
      approveCard.hidden = true;
      doneCard.hidden = false;
      byId("done-title").textContent = "Authorization cancelled";
      byId("done-message").textContent = "Nothing was sent. Run lifty login again when you are ready.";
    });
  </script>
</body>
</html>`;
}
