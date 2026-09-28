import { renderLiftyPage } from "./lifty-brand.js";

export type ConnectionReturnFailure = "canceled" | "failed";

/** A browser return is a receipt, not proof that the provider connected. */
export function renderConnectionReturnPage(channel: "email" | "linkedin", failure: ConnectionReturnFailure | null = null): string {
  const provider = channel === "linkedin" ? "LinkedIn" : "your email provider";
  const account = channel === "linkedin" ? "LinkedIn account" : "email account";
  if (failure) {
    const reason = failure === "canceled"
      ? "You stopped before giving access, so nothing was connected."
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
