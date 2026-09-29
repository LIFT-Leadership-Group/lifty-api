import { renderLiftyPage } from "./lifty-brand.js";

export type ConnectionFailureReason = "canceled" | "provider" | "verification" | "ended";

/** What the server could prove about an attempt from the signed intent alone. */
export type ConnectionReturnResult =
  | { status: "connected"; account: string | null }
  | { status: "failed"; reason: ConnectionFailureReason }
  | { status: "pending" };

export type ConnectionReturnView =
  | { kind: "neutral" }
  | { kind: "confirming"; refreshUrl: string }
  | { kind: "connected"; account: string | null }
  | { kind: "failed"; reason: ConnectionFailureReason };

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** The page claims a connection only when the server verified it. */
export function renderConnectionReturnPage(channel: "email" | "linkedin", view: ConnectionReturnView = { kind: "neutral" }): string {
  const provider = channel === "linkedin" ? "LinkedIn" : "your email provider";
  const account = channel === "linkedin" ? "LinkedIn account" : "email account";
  if (view.kind === "confirming") {
    return renderLiftyPage({
      title: "Confirming your connection",
      head: `<meta http-equiv="refresh" content="3;url=${escape(view.refreshUrl)}">`,
      content: `<h1>Confirming your ${account}</h1><p class="intro">Lifty is checking the connection with ${provider}. This usually takes a few seconds and the page updates by itself.</p><p class="reassurance">You can keep this tab open.</p>`,
    });
  }
  if (view.kind === "connected") {
    // Cloudflare rewrites visible addresses into a script-decoded placeholder,
    // and this page allows no script, so the account opts out of that rewrite.
    const who = view.account ? ` as <strong><!--email_off-->${escape(view.account)}<!--/email_off--></strong>` : "";
    return renderLiftyPage({
      title: "Connected",
      content: `<h1>Your ${account} is connected</h1><p class="intro">Lifty verified the connection${who}.</p><div class="next-step"><strong>Continue in Lifty</strong><p>Return to the conversation where you started, in Claude, ChatGPT or your Lifty app. Nothing is sent until you approve a campaign there.</p></div><p class="reassurance">You can close this tab.</p>`,
    });
  }
  if (view.kind === "failed") {
    const reason = view.reason === "canceled"
      ? "You stopped before giving access, so nothing was connected."
      : view.reason === "verification"
        ? "Lifty could not verify the account you chose, so nothing was connected."
        : view.reason === "ended"
          ? "This connection attempt ended without connecting an account."
          : `${channel === "linkedin" ? "LinkedIn" : "Your email provider"} could not finish the connection, so nothing was connected.`;
    return renderLiftyPage({
      title: "Connection not finished",
      content: `<h1>Your ${account} did not connect</h1><p class="intro">${reason}</p><div class="next-step"><strong>Try again from Lifty</strong><p>Return to the conversation where you started and ask Lifty for a new connection link.</p></div><p class="reassurance">You can close this tab.</p>`,
    });
  }
  return renderLiftyPage({
    title: "Continue in Lifty",
    content: `<h1>Back from ${provider}</h1><p class="intro">You can close this tab and return to the conversation where you started, in Claude, ChatGPT or your Lifty app.</p><div class="next-step"><strong>Check your connection in Lifty</strong><p>Ask Lifty to verify whether your ${account} connected before you continue.</p></div><p class="reassurance">This page does not confirm that your account is connected.</p>`,
  });
}
