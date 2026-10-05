import type { WarmupSetupRecord } from "./warmup-setup.js";
import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";

const escape = (value:string) => value.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const styles = `
.mailbox{margin:20px 0 24px;padding:16px 0;border-block:1px solid var(--line)}
.mailbox strong{display:block;font-size:17px;font-weight:600;overflow-wrap:anywhere}
.hint{margin-top:16px;font-size:13px;color:var(--subtle)}
.actions{margin-top:12px;padding-top:24px;border-top:1px solid var(--line)}
.disclosure{margin-top:14px;font-size:13px;line-height:1.6;color:var(--muted)}
.notice{margin:24px 0 0;padding-left:16px;border-left:2px solid var(--lime);color:var(--muted)}
`;
function shell(title:string, body:string) { return renderLiftyPage({ title: `${escape(title)} · Lifty`, content: body, styles }); }
export function renderWarmupSetupPage(record:WarmupSetupRecord, intent:string, csrf:string):string {
  if (record.state !== "draft") return renderWarmupReceipt("Authorization in progress", "Return to your agent to check warmup status. If Google authorization was interrupted, run warmup start for a new link. A handoff already sent to Mailivery will not be repeated.");
  return shell("Set up email warmup", `<h1>Warm up your mailbox.</h1>
<div class="mailbox"><strong>${escape(record.email)}</strong></div>
<form method="post" action="setup" data-pending="Opening Google…"><input type="hidden" name="intent" value="${escape(intent)}"><input type="hidden" name="csrf" value="${escape(csrf)}">
<p class="hint">Warmup emails go out as ${escape([record.first_name, record.last_name].filter(Boolean).join(" "))}. Lifty sets the warmup schedule and volume.</p>
<div class="actions"><button class="primary block" type="submit">Continue with Google</button><p class="disclosure">Google grants full Gmail access, including reading, sending and deleting mail. Lifty shares this access with Mailivery to send and receive warmup mail. <a href="https://liftygtm.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.</p></div></form>
${pendingSubmitScript}`);
}
export function renderWarmupReceipt(title="Authorization sent", detail="Warmup received the authorization. Return to your agent to check warmup status. Lifty still needs to verify the mailbox before marking warmup as running.") {
  return shell(title, `<p class="eyebrow">Email warmup</p><h1>${escape(title)}</h1><div class="notice"><p>${escape(detail)}</p></div><p class="hint">You can close this tab. This page does not confirm that warmup is running or that outreach is unlocked.</p>`);
}
