import { createHash } from "node:crypto";
import { DEFAULT_WARMUP_POLICY, type WarmupSetupRecord } from "./warmup-setup.js";

// The only script on the page: fills the hidden timezone from the browser.
// Allowed by hash in the setup CSP; without it the server default applies.
const timezoneScript = `try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z)document.getElementById("tz").value=z}catch(e){}`;
export const WARMUP_SETUP_SCRIPT_HASH = `sha256-${createHash("sha256").update(timezoneScript).digest("base64")}`;

const escape = (value:string) => value.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const styles = `
:root{color-scheme:light;--ink:#01333f;--muted:#33616d;--sage:#7fa369;--paper:#f6f8f7;--line:#dbe4e2}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
main{max-width:820px;margin:0 auto;padding:36px 24px 64px}.brand{font-size:30px;font-weight:750;letter-spacing:-1px;margin-bottom:32px}
h1{font:400 42px/1.15 Georgia,serif;letter-spacing:-.8px;margin:0 0 12px}p{margin:8px 0;color:var(--muted)}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.4px;font-weight:650;margin-bottom:14px}.mailbox{margin:26px 0;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.mailbox strong{display:block;font-size:21px;overflow-wrap:anywhere}.hint{font-size:13px;color:var(--muted)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px}label{display:block;font-size:14px;font-weight:600}input{width:100%;min-height:46px;border:1px solid #9fb3b0;border-radius:6px;background:white;color:var(--ink);font:inherit;padding:9px 11px;margin-top:6px}
input:focus-visible,button:focus-visible{outline:3px solid var(--sage);outline-offset:3px}
.actions{margin-top:28px;border-top:1px solid var(--line);padding-top:24px}button{min-height:50px;padding:12px 24px;border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:white;font:600 16px/1.4 inherit;cursor:pointer}button:hover{background:#174b56}
.disclosure{max-width:680px;margin-top:12px;font-size:13px;line-height:1.5}.disclosure a{color:var(--ink);text-underline-offset:2px}
.notice{border-left:3px solid var(--sage);padding:2px 0 2px 16px;margin:24px 0}@media(max-width:540px){main{padding:24px 20px 40px}.grid{grid-template-columns:1fr}h1{font-size:34px}.brand{margin-bottom:24px}button{width:100%}}
`;
function shell(title:string, body:string) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Lifty</title><style>${styles}</style></head><body><main><div class="brand" aria-label="Lifty">lifty</div>${body}</main></body></html>`; }
export function renderWarmupSetupPage(record:WarmupSetupRecord, intent:string, csrf:string):string {
  if (record.state !== "draft") return renderWarmupReceipt("Authorization in progress", "Return to your agent to check warmup status. If Google authorization was interrupted, run warmup start for a new link. A handoff already sent to Mailivery will not be repeated.");
  return shell("Set up email warmup", `<h1>Warm up your mailbox.</h1>
<div class="mailbox"><strong>${escape(record.email)}</strong></div>
<form method="post" action="setup"><input type="hidden" name="intent" value="${escape(intent)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="timezone" id="tz" value="${escape(DEFAULT_WARMUP_POLICY.timezone)}">
<div class="grid">
<label>First name<input name="first_name" autocomplete="given-name" required maxlength="80" value="${escape(record.first_name)}"></label>
<label>Last name<input name="last_name" autocomplete="family-name" maxlength="80" value="${escape(record.last_name)}"></label></div>
<div class="actions"><button type="submit">Continue with Google</button><p class="disclosure">Google grants full Gmail access, including reading, sending and deleting mail. Lifty shares this access with Mailivery to send and receive warmup mail. <a href="https://liftygtm.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.</p></div></form>
<script>${timezoneScript}</script>`);
}
export function renderWarmupReceipt(title="Authorization sent", detail="Mailivery received the handoff. Return to your agent to check warmup status. Lifty still needs to verify the mailbox through Mailivery before marking it connected.") {
  return shell(title, `<div class="eyebrow">Email warmup</div><h1>${escape(title)}</h1><div class="notice"><p>${escape(detail)}</p></div><p class="hint">You can close this tab. This page does not confirm that warmup is running or that outreach is unlocked.</p>`);
}
