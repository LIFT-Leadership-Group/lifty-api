/** The existing personal-mailbox declaration is completed in the browser. */
export function renderEmailAuthorizationPage(state: string, chooseProvider = false): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your email account · Lifty</title><style>body{font:18px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#202124}button{font:inherit;padding:.7rem 1rem;margin-top:1rem}.brand{color:#145b58;font-weight:700;font-size:1.4rem;margin:0 0 1.25rem}label{display:block}input{margin-right:.6rem}</style>
<p class="brand">Lifty</p><h1>Connect your email account</h1><p>Connect the mailbox you already use for everyday conversations. Choose Gmail, Google Workspace, Outlook, Microsoft 365, or IMAP/SMTP. You will review and approve your outreach before any email is sent.</p>
<form method="post" action="/unipile/start"><input type="hidden" name="intent" value="${escape(state)}">
<label><input type="checkbox" name="mailbox_use" value="personal" required>I use this mailbox regularly for personal or business conversations. It is not a new or dedicated outreach mailbox.</label>
${chooseProvider ? `<fieldset><legend>Choose your email provider</legend>
<label><input type="radio" name="email_provider" value="google" required>Google (Gmail or Google Workspace)</label>
<label><input type="radio" name="email_provider" value="outlook" required>Microsoft (Outlook or Microsoft 365)</label>
<label><input type="radio" name="email_provider" value="imap" required>Other email (IMAP/SMTP)</label></fieldset>` : ""}
<button type="submit">Continue to account selection</button></form></html>`;
}

/** A used single-use link should confirm receipt instead of replaying authorization. */
export function renderEmailAuthorizationReceivedPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email authorization received · Lifty</title><style>body{font:18px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#202124}</style>
<h1>We received your authorization</h1><p>Return to your agent to check the connection and continue preparing your messages.</p></html>`;
}
