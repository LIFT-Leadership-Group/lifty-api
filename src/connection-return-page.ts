import { renderLiftyPage } from "./lifty-brand.js";

/** A browser return is a receipt, not proof that the provider connected. */
export function renderConnectionReturnPage(channel: "email" | "linkedin"): string {
  const provider = channel === "linkedin" ? "LinkedIn" : "your email provider";
  const account = channel === "linkedin" ? "LinkedIn account" : "email account";
  return renderLiftyPage({
    title: "Continue in Lifty",
    content: `<h1>Back from ${provider}</h1><p class="intro">You can close this tab and return to the conversation where you started, in Claude, ChatGPT or your Lifty app.</p><div class="next-step"><strong>Check your connection in Lifty</strong><p>Ask Lifty to verify whether your ${account} connected before you continue.</p></div><p class="reassurance">This page does not confirm that your account is connected.</p>`,
  });
}
