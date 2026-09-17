/** The existing personal-mailbox declaration is completed in the browser. */
export function renderEmailAuthorizationPage(state: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your email account · Lifty</title><style>body{font:18px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#202124}button{font:inherit;padding:.7rem 1rem;margin-top:1rem}label{display:block}input{margin-right:.6rem}</style>
<h1>Connect your email account</h1><p>Continue to choose your Gmail or Google Workspace account. This beta supports a personal mailbox you already use regularly. Connecting it does not send email.</p>
<form method="post" action="/unipile/start"><input type="hidden" name="intent" value="${escape(state)}">
<label><input type="checkbox" name="mailbox_use" value="personal" required>I will connect my regular personal mailbox, not a new or dedicated outreach mailbox.</label>
<button type="submit">Continue to account selection</button></form></html>`;
}

/** A used single-use link should confirm receipt instead of replaying authorization. */
export function renderEmailAuthorizationReceivedPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email authorization received · Lifty</title><style>body{font:18px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#202124}</style>
<h1>We received your authorization</h1><p>Return to Lifty to check the connection and continue preparing your messages.</p></html>`;
}
