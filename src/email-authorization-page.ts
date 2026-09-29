import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";

const styles = `
  form{margin-top:28px}
  fieldset{border:0;margin:0 0 26px;padding:0;min-width:0}
  legend{padding:0;margin-bottom:12px;font-size:14px;font-weight:600}
  .providers{display:grid;gap:10px}
  .provider{display:flex;align-items:center;gap:14px;min-height:76px;margin:0;font-size:16px;font-weight:400;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:hsl(160 12% 6% / .6);cursor:pointer;transition:background-color 160ms,border-color 160ms}
  .provider:hover{border-color:hsl(140 16% 96% / .28)}
  .provider:has(input:checked){border-color:hsl(99 34% 65% / .75);background:hsl(99 34% 65% / .08);box-shadow:inset 0 0 0 1px hsl(99 34% 65% / .75)}
  .provider:has(input:focus-visible){outline:2px solid var(--lime);outline-offset:3px}
  .provider input:focus-visible{outline:none}
  .provider-icon{width:26px;height:26px;flex:none}
  .provider-copy{flex:1;min-width:0}
  .provider-name{display:block;font-weight:600;line-height:1.4}
  .provider-detail{display:block;font-size:13px;font-weight:400;color:var(--muted);margin-top:2px}
  button[type=submit]{margin-top:26px}
  form[aria-busy=true] fieldset{opacity:.55;pointer-events:none}
  @media(max-width:560px){.provider{padding:13px 12px;gap:12px}}
  @media(prefers-reduced-motion:reduce){.provider{transition:none}}
  @media(forced-colors:active){.provider:has(input:checked){outline:2px solid Highlight;outline-offset:-2px}}
`;

const providerIcons = {
  google: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.04H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.32 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.97-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.8-1.76-5.59-4.13H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02Z"/><path fill="#ea4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"/></svg>`,
  outlook: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#f25022" d="M2 2h9v9H2z"/><path fill="#7fba00" d="M13 2h9v9h-9z"/><path fill="#00a4ef" d="M2 13h9v9H2z"/><path fill="#ffb900" d="M13 13h9v9h-9z"/></svg>`,
  imap: `<svg class="provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 6 9 7 9-7"/></svg>`,
};

function page(title: string, content: string, scripts = ""): string {
  return renderLiftyPage({ title: `${title} · Lifty`, content, styles, scripts });
}

function providerChoices(): string {
  const providers = [
    { value: "google", name: "Google", detail: "Gmail or Google Workspace" },
    { value: "outlook", name: "Microsoft", detail: "Outlook or Microsoft 365" },
    { value: "imap", name: "Other email", detail: "IMAP/SMTP" },
  ] as const;
  return `<fieldset><legend>Choose your email provider</legend><div class="providers">${providers.map(provider => `<label class="provider">${providerIcons[provider.value]}<span class="provider-copy"><span class="provider-name">${provider.name}</span><span class="provider-detail">${provider.detail}</span></span><input type="radio" name="email_provider" value="${provider.value}" aria-label="${provider.name} (${provider.detail})" required></label>`).join("")}</div></fieldset>`;
}

// Regular mailboxes stay the default. A new or dedicated account is declared
// here and must finish verified warmup before any campaign can send (LIF-985).
function mailboxUseChoices(): string {
  const choices = [
    { value: "personal", name: "A mailbox I already use", detail: "Personal or business conversations. Campaigns can start once you approve them.", checked: true },
    { value: "outreach", name: "A new account for outreach", detail: "A new or dedicated address. It needs 21 active days of warmup before campaigns send.", checked: false },
  ] as const;
  return `<fieldset><legend>How do you use this mailbox?</legend><div class="providers">${choices.map(choice => `<label class="provider"><span class="provider-copy"><span class="provider-name">${choice.name}</span><span class="provider-detail">${choice.detail}</span></span><input type="radio" name="mailbox_use" value="${choice.value}" aria-label="${choice.name}"${choice.checked ? " checked" : ""} required></label>`).join("")}</div></fieldset>`;
}

/** Provider choice and the mailbox-use declaration are completed in the browser. */
export function renderEmailAuthorizationPage(state: string, chooseProvider = false): string {
  const escapedState = state.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return page("Connect your email account", `<h1>Connect your email account</h1>
<p class="intro">Connect the mailbox Lifty should send from. It can be one you already use or a new account set up for outreach.</p>
<form method="post" action="/unipile/start" data-pending="Opening account selection…"><input type="hidden" name="intent" value="${escapedState}">
${chooseProvider ? providerChoices() : ""}
${mailboxUseChoices()}
<button class="primary block" type="submit">Continue to account selection</button></form>
<p class="reassurance">Connecting your email does not start outreach. You will review and approve your outreach before any email is sent.</p>`, pendingSubmitScript);
}

/** A used single-use link should confirm receipt instead of replaying authorization. */
export function renderEmailAuthorizationReceivedPage(): string {
  return page("Email authorization received", `<div class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg></div>
<h1>We received your authorization</h1>
<p class="intro">Return to your agent to check your connection status.</p>
<div class="next-step"><strong>You can close this tab</strong><p>Your agent will confirm when the connection is ready and help you continue preparing your messages.</p></div>
<p class="reassurance">Connecting your email does not start outreach.</p>`);
}
