import { DEFAULT_WARMUP_POLICY, WARMUP_SCHEDULES, type WarmupSetupRecord } from "./warmup-setup.js";

const escape = (value:string) => value.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const styles = `
:root{color-scheme:light;--ink:#01333f;--muted:#33616d;--sage:#7fa369;--paper:#f6f8f7;--line:#dbe4e2}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
main{max-width:820px;margin:0 auto;padding:36px 24px 64px}.brand{font-size:30px;font-weight:750;letter-spacing:-1px;margin-bottom:32px}
h1{font:400 42px/1.15 Georgia,serif;letter-spacing:-.8px;margin:0 0 12px}p{margin:8px 0;color:var(--muted)}
.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:1.4px;font-weight:650;margin-bottom:14px}.mailbox{margin:26px 0;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.mailbox strong{display:block;font-size:21px;overflow-wrap:anywhere}.hint{font-size:13px;color:var(--muted)}fieldset{border:0;padding:0;margin:28px 0 0;min-width:0}legend{font-size:19px;font-weight:650;margin:0 0 16px;padding:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px}label{display:block;font-size:14px;font-weight:600}input,select{width:100%;min-height:46px;border:1px solid #9fb3b0;border-radius:6px;background:white;color:var(--ink);font:inherit;padding:9px 11px;margin-top:6px}
input:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid var(--sage);outline-offset:3px}.choice{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:10px;cursor:pointer;background:white}
.choice:has(input:checked){border-color:var(--ink);background:#edf3ee}.choice input{width:19px;min-height:19px;height:19px;flex:none;accent-color:var(--ink);margin:3px 0 0}.choice span{display:block}.choice .hint{font-weight:400;margin-top:3px}
.actions{margin-top:28px;border-top:1px solid var(--line);padding-top:24px}button{min-height:50px;padding:12px 24px;border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:white;font:600 16px/1.4 inherit;cursor:pointer}button:hover{background:#174b56}
.notice{border-left:3px solid var(--sage);padding:2px 0 2px 16px;margin:24px 0}.full{grid-column:1/-1}@media(max-width:540px){main{padding:24px 20px 40px}.grid{grid-template-columns:1fr}h1{font-size:34px}.brand{margin-bottom:24px}button{width:100%}}
`;
function shell(title:string, body:string) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Lifty</title><style>${styles}</style></head><body><main><div class="brand" aria-label="Lifty">lifty</div>${body}</main></body></html>`; }
const options = (values:readonly string[], selected:string) => values.map(value=>`<option value="${escape(value)}"${value===selected?" selected":""}>${escape(value)}</option>`).join("");
export function renderWarmupSetupPage(record:WarmupSetupRecord, intent:string, csrf:string, fallback:boolean):string {
  if (record.state !== "draft") return renderWarmupReceipt("Authorization in progress", "Return to your agent to check warmup status. If Google authorization was interrupted, run warmup start for a new link. A handoff already sent to Mailivery will not be repeated.");
  const policy = record.policy ?? DEFAULT_WARMUP_POLICY;
  return shell("Set up email warmup", `<div class="eyebrow">Email warmup</div><h1>Build a healthy sending rhythm.</h1>
<p>Choose your warmup strategy, then authorize Mailivery to use your mailbox.</p>
<div class="mailbox"><span class="hint">Your mailbox, verified through Unipile</span><strong>${escape(record.email)}</strong><span class="hint">Google must verify this exact address. You do not need a new mailbox.</span></div>
<form method="post" action="setup"><input type="hidden" name="intent" value="${escape(intent)}"><input type="hidden" name="csrf" value="${escape(csrf)}">
<fieldset><legend>1. Your sending profile</legend><div class="grid">
<label>First name<input name="first_name" autocomplete="given-name" required maxlength="80" value="${escape(record.first_name)}"></label>
<label>Last name <span class="hint">(optional)</span><input name="last_name" autocomplete="family-name" maxlength="80" value="${escape(record.last_name)}"></label></div></fieldset>
<fieldset><legend>2. Warmup strategy</legend><div class="grid">
<label>Target volume per day<input name="emails_per_day" type="number" min="1" max="100" step="1" required value="${policy.emails_per_day}" aria-describedby="volume-hint"><span class="hint" id="volume-hint">1–100 warmup emails, separate from outreach.</span></label>
<label>Ramp speed<select name="ramp">${options(["slow","normal","fast"],policy.ramp)}</select><span class="hint">Choose slow for a brand-new domain.</span></label>
<label>Reply rate (%)<input name="reply_rate" type="number" min="0" max="55" step="1" required value="${policy.reply_rate}"><span class="hint">Up to 55%, subject to the Mailivery plan.</span></label>
<label>Audience<select name="audience">${options(["inherit","all","business","consumer"],policy.audience)}</select><span class="hint">Inherit uses the Mailivery team setting.</span></label>
<label>Sending schedule<select name="schedule">${options(WARMUP_SCHEDULES,policy.schedule)}</select></label>
<label>Timezone<input name="timezone" value="${escape(policy.timezone)}" required maxlength="100" list="timezones" spellcheck="false" autocomplete="off"><datalist id="timezones">${options(["America/New_York","America/Chicago","America/Los_Angeles","America/Argentina/Buenos_Aires","Europe/London","Europe/Madrid","UTC"],"")}</datalist><span class="hint">An IANA timezone, for example America/New_York.</span></label>
</div><p class="hint">Volume shares your team's Mailivery allowance. Mailivery may reject a strategy that exceeds its limits. These settings are saved for this mailbox when you continue.</p></fieldset>
<fieldset><legend>3. Authorize the same mailbox</legend>
<label class="choice"><input type="radio" name="method" value="google" checked required><span>Google OAuth <span class="hint">Recommended. Continue to Google's consent screen; no App Password needed.</span></span></label>
${fallback?`<label class="choice"><input type="radio" name="method" value="app_password"><span>App Password <span class="hint">Optional fallback. Enter it only on Mailivery's next page, never in Lifty or chat.</span></span></label>`:""}
<p class="hint">Google authorization grants full mailbox access to support Mailivery's sending and reading. Lifty passes the access and refresh tokens to Mailivery once, without storing or logging them. Mailivery stores the credentials needed to keep warmup running.</p></fieldset>
<div class="actions"><button type="submit">Save strategy and continue</button><p class="hint">This authorizes warmup, not outreach campaigns. A new outreach mailbox still needs 21 active, healthy warmup days.</p></div></form>`);
}
export function renderWarmupReceipt(title="Authorization sent", detail="Mailivery received the handoff. Return to your agent to check warmup status. Lifty still needs to verify the mailbox through Mailivery before marking it connected.") {
  return shell(title, `<div class="eyebrow">Email warmup</div><h1>${escape(title)}</h1><div class="notice"><p>${escape(detail)}</p></div><p class="hint">You can close this tab. This page does not confirm that warmup is running or that outreach is unlocked.</p>`);
}
