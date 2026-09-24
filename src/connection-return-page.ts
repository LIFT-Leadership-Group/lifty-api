import { liftyBrand } from "./lifty-brand.js";

const styles = `
  :root{color-scheme:light;--ink:#01333f;--muted:#33616d;--sage:#7fa369;--paper:#f6f8f7;--line:#dbe4e2}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .shell{min-height:100svh;display:grid;place-items:center;padding:32px 16px}
  .panel{width:100%;max-width:520px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:40px;box-shadow:0 12px 48px #01333f08}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 38px;font-size:31px;line-height:1;font-weight:750;letter-spacing:-1.2px}
  .brand svg{width:31px;height:43px;flex:none}
  h1{font:400 36px/1.15 Georgia,"Times New Roman",serif;letter-spacing:-.8px;margin:0 0 14px;text-wrap:balance}
  .intro{color:var(--muted);margin:0;max-width:43ch}
  .next-step{border-left:3px solid var(--sage);padding-left:16px;margin:28px 0 0;color:var(--muted)}
  .next-step strong{display:block;color:var(--ink);font-size:15px;margin-bottom:5px}
  .next-step p{margin:0;font-size:14px}
  .reassurance{border-top:1px solid var(--line);margin:28px 0 0;padding-top:20px;color:var(--muted);font-size:13px;line-height:1.65}
  @media(max-width:560px){.shell{align-items:start;padding:24px 16px}.panel{padding:28px 24px;border-radius:16px}.brand{margin-bottom:32px}h1{font-size:32px}}
`;

/** A browser return is a receipt, not proof that the provider connected. */
export function renderConnectionReturnPage(channel: "email" | "linkedin"): string {
  const provider = channel === "linkedin" ? "LinkedIn" : "your email provider";
  const account = channel === "linkedin" ? "LinkedIn account" : "email account";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Continue in Lifty</title><style>${styles}</style></head><body><main class="shell"><section class="panel" aria-labelledby="page-title">${liftyBrand}<h1 id="page-title">Back from ${provider}</h1><p class="intro">You can close this tab and return to your Lifty agent.</p><div class="next-step"><strong>Check your connection in Lifty</strong><p>Ask your agent to verify whether your ${account} connected before you continue.</p></div><p class="reassurance">This page does not confirm that your account is connected.</p></section></main></body></html>`;
}
