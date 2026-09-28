import { authBrowserScript } from "./auth-browser.js";
import { renderLiftyPage } from "./lifty-brand.js";

const styles = `
form{margin-top:26px}
#message{margin-top:16px;font-size:14px}
.aside{display:grid;gap:8px;margin-top:24px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
`;

export type PasswordRecoveryPage = "request" | "update";
export interface PasswordRecoveryPageOptions {
  supabaseUrl: string;
  publishableKey: string;
  publicBaseUrl: string;
  scriptNonce: string;
  page: PasswordRecoveryPage;
}

/** Implicit recovery works across browsers; no verifier, persistent session or CLI handoff. */
export function renderPasswordRecoveryPage(options: PasswordRecoveryPageOptions): string {
  const publicUrl = new URL(options.publicBaseUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("Invalid recovery origin");
  const configuration = JSON.stringify({
    supabaseUrl: options.supabaseUrl.replace(/\/$/, ""),
    publishableKey: options.publishableKey,
    redirectTo: `${publicUrl.origin}/auth/password-update`,
    page: options.page,
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  const request = options.page === "request";
  return renderLiftyPage({
    title: "Reset your Lifty password",
    styles,
    content: `<h1 id="title">${request ? "Forgot your password?" : "Choose a new password"}</h1>
<p class="intro" id="description">${request ? "Enter your email to request a password recovery link." : "Checking your recovery link..."}</p>
<form id="request-form"${request ? "" : " hidden"}>
<label>Email<input id="email" type="email" autocomplete="email" maxlength="254" required></label>
<button class="primary block" id="request-submit" type="submit">Send recovery email</button></form>
<form id="update-form" hidden>
<label>New password<input id="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></label>
<label>Confirm new password<input id="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></label>
<button class="primary block" id="update-submit" type="submit" disabled>Change password</button></form>
<p id="message" role="status" aria-live="polite" hidden></p>
<div class="aside"><p id="new-link"${request ? " hidden" : ""}><a href="/auth/password-reset">Request a new recovery link</a></p>
<p id="return-login">Return to your original Lifty login tab after changing your password. If it has closed or timed out, run <code>lifty login</code> again.</p></div>`,
    scripts: `<script nonce="${options.scriptNonce}">
"use strict";
const config = ${configuration};
const byId = id => document.getElementById(id);
// Remove bearer material before any asynchronous operation or external request.
let fragment = new URLSearchParams(window.location.hash.slice(1));
let query = new URLSearchParams(window.location.search);
history.replaceState(null, "", window.location.pathname);
let accessToken = null;
let expiresAt = 0;
let busy = false;
let pageActive = true;
${authBrowserScript}
function showMessage(text, success = false) {
  byId("message").textContent = text;
  byId("message").className = success ? "success" : "error";
  byId("message").hidden = false;
}
function discardSession() {
  accessToken = null;
  expiresAt = 0;
  byId("new-password").value = "";
  byId("confirm-password").value = "";
  byId("update-submit").disabled = true;
}
function invalidLink() {
  discardSession();
  byId("update-form").hidden = true;
  byId("description").textContent = "Request a new recovery email and use its newest link.";
  showMessage("This recovery link is invalid, expired, or already used.");
}
window.addEventListener("pagehide", () => { pageActive = false; discardSession(); });
byId("request-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  byId("request-submit").disabled = true;
  byId("message").hidden = true;
  try {
    await authRequest("/auth/v1/recover?" + new URLSearchParams({redirect_to:config.redirectTo}),
      {body:{email:byId("email").value.trim()}});
    showMessage("If an account exists for that email, you'll receive a password recovery link. Check your inbox and spam folder.", true);
  } catch (error) {
    // Auth normally returns identical 200 responses for existing/absent users.
    if (error?.code === "user_not_found") showMessage("If an account exists for that email, you'll receive a password recovery link. Check your inbox and spam folder.", true);
    else showMessage(safeAuthMessage(error, "recovery-request"));
  } finally { busy = false; byId("request-submit").disabled = false; }
});
byId("update-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  if (!accessToken || Date.now() >= expiresAt) { invalidLink(); return; }
  const password = byId("new-password").value;
  if (password.length < 8 || password.length > 1024) { showMessage("Choose a password with at least 8 characters."); return; }
  if (password !== byId("confirm-password").value) { showMessage("The passwords don't match. Enter the same password twice."); return; }
  busy = true;
  byId("update-submit").disabled = true;
  byId("message").hidden = true;
  try {
    await authRequest("/auth/v1/user", {method:"PUT",body:{password},accessToken});
    const completedToken = accessToken;
    discardSession();
    byId("update-form").hidden = true;
    byId("new-link").hidden = true;
    byId("title").textContent = "Password changed";
    byId("description").textContent = "Sign in with your new password in the original Lifty login tab, then approve the CLI normally.";
    showMessage("Your password was changed. Sign in again to continue.", true);
    // Best effort: revoke only this recovery session, without claiming immediate
    // JWT invalidation or logging out the user's other product sessions.
    try { await authRequest("/auth/v1/logout?scope=local", {accessToken:completedToken}); } catch {}
  } catch (error) {
    if (error?.kind === "network" || error?.status >= 500) {
      discardSession(); byId("update-form").hidden = true;
      showMessage("We couldn't confirm whether your password changed. Try signing in with the new password. If needed, request a fresh recovery link.");
    } else {
      showMessage(safeAuthMessage(error, "password-update"));
      if ([401,403].includes(error?.status) || ["reauthentication_needed","otp_expired","bad_jwt","session_not_found","user_not_found"].includes(error?.code)) discardSession();
    }
  } finally { busy = false; byId("update-submit").disabled = !accessToken; }
});
async function startRecovery() {
  if (config.page !== "update") { fragment = null; query = null; return; }
  const types = fragment.getAll("type");
  const tokens = fragment.getAll("access_token");
  const lifetime = Number(fragment.get("expires_in"));
  const expiry = fragment.has("expires_at") ? Number(fragment.get("expires_at")) * 1000 : Date.now() + lifetime * 1000;
  const invalid = query.size > 0 || fragment.has("error") || fragment.has("error_code")
    || types.length !== 1 || types[0] !== "recovery" || tokens.length !== 1
    || !/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(tokens[0] || "")
    || tokens[0].length > 16384 || !Number.isFinite(expiry) || expiry <= Date.now()
    || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86400;
  const candidate = invalid ? null : tokens[0];
  fragment = null; query = null;
  if (!candidate) { invalidLink(); return; }
  busy = true;
  try {
    const user = await authRequest("/auth/v1/user", {method:"GET",accessToken:candidate});
    if (!pageActive) return;
    if (!user || typeof user.id !== "string" || !user.id) { invalidLink(); return; }
    accessToken = candidate; expiresAt = Math.min(expiry, Date.now() + lifetime * 1000);
    byId("description").textContent = "Enter and confirm your new password.";
    byId("update-form").hidden = false;
    byId("update-submit").disabled = false;
  } catch (error) {
    discardSession();
    byId("description").textContent = "We couldn't verify this recovery session. Request a fresh link when you're ready.";
    showMessage(safeAuthMessage(error, "validate"));
  } finally { busy = false; }
}
void startRecovery();
</script>`,
  });
}
