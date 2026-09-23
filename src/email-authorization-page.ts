const styles = `
  :root{color-scheme:light;--ink:#01333f;--muted:#33616d;--sage:#7fa369;--paper:#f6f8f7;--line:#dbe4e2}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .shell{min-height:100svh;display:grid;place-items:center;padding:48px 24px}
  .panel{width:100%;max-width:520px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:40px;box-shadow:0 12px 48px #01333f08}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 32px;font-size:31px;line-height:1;font-weight:750;letter-spacing:-1.2px}
  .brand svg{width:31px;height:43px;flex:none}
  h1{font:400 36px/1.15 Georgia,"Times New Roman",serif;letter-spacing:-.8px;margin:0 0 14px;text-wrap:balance}
  .intro{color:var(--muted);margin:0;max-width:43ch}
  form{margin-top:28px}
  fieldset{border:0;margin:0 0 26px;padding:0;min-width:0}
  legend{padding:0;margin-bottom:12px;font-size:14px;font-weight:650}
  .providers{display:grid;gap:10px}
  .provider{display:flex;align-items:center;gap:14px;min-height:76px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
  .provider:hover{border-color:var(--muted);background:#fafcfb}
  .provider:has(input:checked){border-color:var(--ink);background:#f0f5f2;box-shadow:inset 0 0 0 1px var(--ink)}
  .provider:has(input:focus-visible){outline:3px solid var(--muted);outline-offset:3px}
  .provider-icon{width:26px;height:26px;flex:none}
  .provider-copy{flex:1;min-width:0}
  .provider-name{display:block;font-weight:650;line-height:1.4}
  .provider-detail{display:block;font-size:13px;color:var(--muted);margin-top:2px}
  input[type=radio],input[type=checkbox]{accent-color:var(--ink);width:19px;height:19px;flex:none;margin:0;cursor:pointer}
  input:focus-visible{outline:3px solid var(--muted);outline-offset:3px}
  .declaration{display:flex;align-items:flex-start;gap:12px;cursor:pointer;color:var(--muted);font-size:14px;line-height:1.6}
  .declaration input{margin-top:3px}
  .declaration strong{color:var(--ink);font-weight:600}
  .declaration-detail{display:block;margin-top:3px}
  button{display:block;width:100%;min-height:52px;margin-top:26px;padding:13px 16px;border:1px solid var(--ink);border-radius:10px;background:var(--ink);color:#fff;font:600 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer}
  button:hover{background:#174b56}
  button:focus-visible{outline:3px solid var(--muted);outline-offset:4px}
  .reassurance{border-top:1px solid var(--line);margin:24px 0 0;padding-top:20px;color:var(--muted);font-size:13px;line-height:1.65}
  .receipt-symbol{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:#eef4eb;color:var(--ink);margin-bottom:22px}
  .receipt-symbol svg{width:26px;height:26px}
  .next-step{border-left:3px solid var(--sage);padding-left:16px;margin:26px 0 0;color:var(--muted)}
  .next-step strong{display:block;color:var(--ink);font-size:15px;margin-bottom:5px}
  .next-step p{margin:0;font-size:14px}
  @media(max-width:560px){.shell{padding:24px 16px;align-items:start}.panel{padding:28px 24px;border-radius:16px}.brand{margin-bottom:28px}h1{font-size:32px}.provider{padding:13px 12px;gap:12px}}
  @media(forced-colors:active){.provider:has(input:checked){outline:2px solid Highlight;outline-offset:-2px}}
`;

// Static LiftyMark/BirdGlyph/PerchedHead geometry from the dashboard landing brand.
// Keep these paths aligned with components/landing/lifty-mark.tsx and perched-head.tsx.
const brand = `<div class="brand" aria-label="Lifty" role="img"><svg viewBox="18 7 43 60" fill="none" aria-hidden="true" focusable="false">
<path stroke="hsl(192 26% 86%)" stroke-width="1.3" stroke-linejoin="bevel" d="M39 54 38 60 34 63 33 65 M38 60 42 63 42 65 M46 51 45 59 43 62 42 64 M45 59 50 62 50 64"/>
<path fill="hsl(140 16% 96%)" stroke="hsl(195 40% 37% / .55)" stroke-width=".55" stroke-linejoin="round" d="M32 42 21 65 27 63 39 46Z"/>
<path fill="hsl(195 40% 37%)" d="M50 25Q57 27 56 34L52 44 46 50 48 35Z"/>
<path fill="hsl(196 66% 16% / .22)" d="M54 28 56 32 52 44 46 50 50 41Z"/>
<path fill="hsl(140 16% 96%)" stroke="hsl(195 40% 37% / .55)" stroke-width=".55" stroke-linejoin="round" d="M33 21 44 19Q52 20 55 27Q54 33 50 39L43 54 38 57 33 53 29 43 29 31Z"/>
<path fill="hsl(192 26% 86%)" d="M48 22Q53 23 55 27Q54 33 50 39L43 54 38 57 46 39Q53 29 48 22Z"/>
<g fill="hsl(140 16% 96%)" stroke="hsl(195 40% 37% / .55)" stroke-width=".55" stroke-linejoin="round"><path d="M33 18.5L46 18L50 27L40 29L33 23Z"/><path d="M29 15.5L32 11.5L39 9.5L45 10.5L49 15.5L50 22.5L44 24.5L37 20.5L32 20.5Z"/></g>
<g fill="hsl(195 40% 37%)"><path d="M27 17.5L31 15.5L35 16.5L32 19.5L26 20.5Z"/><path d="M28 17.5Q23 18.5 25 22.5L28 25.5L27.5 21.5L32 19.5Z"/></g>
<path fill="hsl(196 66% 16% / .22)" d="M25 20.5L27.5 21.5L28 25.5L25 22.5Z"/>
<circle fill="hsl(196 66% 16%)" cx="36" cy="16.3" r="4.4"/><circle stroke="hsl(99 34% 65%)" stroke-width=".45" cx="36" cy="16.3" r="3.55"/><circle fill="hsl(99 34% 65%)" cx="36" cy="16.3" r="1.55"/>
<path fill="hsl(195 40% 37%)" d="M32 25Q37 24 40 28L38 36 32 48 22 62 26 39Q27 30 32 25Z"/>
<path fill="hsl(196 66% 16% / .22)" d="m37 26 3 2-2 8-6 12-10 14 8-17 5-12Z"/>
</svg><span aria-hidden="true">lifty</span></div>`;

const providerIcons = {
  google: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.04H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.32 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.97-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.8-1.76-5.59-4.13H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02Z"/><path fill="#ea4335" d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"/></svg>`,
  outlook: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#f25022" d="M2 2h9v9H2z"/><path fill="#7fba00" d="M13 2h9v9h-9z"/><path fill="#00a4ef" d="M2 13h9v9H2z"/><path fill="#ffb900" d="M13 13h9v9h-9z"/></svg>`,
  imap: `<svg class="provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m3 6 9 7 9-7"/></svg>`,
};

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Lifty</title><style>${styles}</style></head><body><main class="shell"><section class="panel" aria-labelledby="page-title">${brand}${content}</section></main></body></html>`;
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
  return page("Connect your email account", `<h1 id="page-title">Connect your email account</h1>
<p class="intro">Connect the mailbox Lifty should send from. It can be one you already use or a new account set up for outreach.</p>
<form method="post" action="/unipile/start"><input type="hidden" name="intent" value="${escapedState}">
${chooseProvider ? providerChoices() : ""}
${mailboxUseChoices()}
<button type="submit">Continue to account selection</button></form>
<p class="reassurance">Connecting your email does not start outreach. You will review and approve your outreach before any email is sent.</p>`);
}

/** A used single-use link should confirm receipt instead of replaying authorization. */
export function renderEmailAuthorizationReceivedPage(): string {
  return page("Email authorization received", `<div class="receipt-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg></div>
<h1 id="page-title">We received your authorization</h1>
<p class="intro">Return to your agent to check your connection status.</p>
<div class="next-step"><strong>You can close this tab</strong><p>Your agent will confirm when the connection is ready and help you continue preparing your messages.</p></div>
<p class="reassurance">Connecting your email does not start outreach.</p>`);
}
