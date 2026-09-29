import { createHash } from "node:crypto";
import { DEFAULT_WARMUP_POLICY, type WarmupSetupRecord } from "./warmup-setup.js";
import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";

// Fills the hidden timezone from the browser. Allowed by hash in the setup
// CSP next to the shared pending-submit script; without it the server default applies.
const timezoneScript = `try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z)document.getElementById("tz").value=z}catch(e){}`;
export const WARMUP_SETUP_SCRIPT_HASH = `sha256-${createHash("sha256").update(timezoneScript).digest("base64")}`;

const escape = (value:string) => value.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const styles = `
.mailbox{margin:20px 0 24px;padding:16px 0;border-block:1px solid var(--line)}
.mailbox strong{display:block;font-size:17px;font-weight:600;overflow-wrap:anywhere}
.hint{margin-top:16px;font-size:13px;color:var(--subtle)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.actions{margin-top:12px;padding-top:24px;border-top:1px solid var(--line)}
.disclosure{margin-top:14px;font-size:13px;line-height:1.6;color:var(--muted)}
.notice{margin:24px 0 0;padding-left:16px;border-left:2px solid var(--lime);color:var(--muted)}
form[aria-busy=true] .grid{opacity:.55;pointer-events:none}
@media(max-width:540px){.grid{grid-template-columns:1fr}}
`;
function shell(title:string, body:string) { return renderLiftyPage({ title: `${escape(title)} · Lifty`, content: body, styles }); }
export function renderWarmupSetupPage(record:WarmupSetupRecord, intent:string, csrf:string):string {
  if (record.state !== "draft") return renderWarmupReceipt("Authorization in progress", "Return to your agent to check warmup status. If Google authorization was interrupted, run warmup start for a new link. A handoff already sent to Mailivery will not be repeated.");
  return shell("Set up email warmup", `<h1>Warm up your mailbox.</h1>
<div class="mailbox"><strong>${escape(record.email)}</strong></div>
<form method="post" action="setup" data-pending="Opening Google…"><input type="hidden" name="intent" value="${escape(intent)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="timezone" id="tz" value="${escape(DEFAULT_WARMUP_POLICY.timezone)}">
<div class="grid">
<label>First name<input name="first_name" autocomplete="given-name" required maxlength="80" value="${escape(record.first_name)}"></label>
<label>Last name<input name="last_name" autocomplete="family-name" maxlength="80" value="${escape(record.last_name)}"></label></div>
<div class="actions"><button class="primary block" type="submit">Continue with Google</button><p class="disclosure">Google grants full Gmail access, including reading, sending and deleting mail. Lifty shares this access with Mailivery to send and receive warmup mail. <a href="https://liftygtm.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.</p></div></form>
<script>${timezoneScript}</script>${pendingSubmitScript}`);
}
export function renderWarmupReceipt(title="Authorization sent", detail="Mailivery received the handoff. Return to your agent to check warmup status. Lifty still needs to verify the mailbox through Mailivery before marking it connected.") {
  return shell(title, `<p class="eyebrow">Email warmup</p><h1>${escape(title)}</h1><div class="notice"><p>${escape(detail)}</p></div><p class="hint">You can close this tab. This page does not confirm that warmup is running or that outreach is unlocked.</p>`);
}
