import { createHash } from "node:crypto";

// Órbita Fase mark, palette and controls from the dashboard's public brand.
// Keep aligned with lift-gtm-dashboard components/landing/lifty-mark.tsx,
// shell.module.css and buttons.module.css.
// Hosted pages run under `default-src 'none'`: everything stays inline, and
// Inter is used when installed, falling back to the system sans-serif.

const orbitPaths = `<path d="M216 47C225 47 228 54 221 61C158 78 80 125 64 163C37 226 144 229 236 188C270 173 297 150 311 123L324 147C289 191 224 226 161 244C82 267 23 251 11 220C-10 166 85 89 178 58C193 53 205 49 216 47Z"/><path d="M268 17C311 16 349 41 351 78C352 91 347 104 341 113C334 122 326 113 324 102C316 71 294 50 255 42C251 41 251 37 254 34L264 20Q265 17 268 17Z"/>`;

const liftyMark = `<svg class="mark" viewBox="0 0 400 400" fill="currentColor" aria-hidden="true" focusable="false"><g transform="translate(20 65)">${orbitPaths}</g></svg>`;

export const liftyBrand = `<div class="brand" aria-label="Lifty" role="img">${liftyMark}<span aria-hidden="true">lifty</span></div>`;

export const liftyStyles = `
:root{color-scheme:dark;--paper:hsl(160 14% 4%);--card:hsl(160 8% 9%);--field:hsl(160 12% 6%);--ink:hsl(140 16% 96%);--muted:hsl(140 16% 96% / .68);--subtle:hsl(140 16% 96% / .5);--line:hsl(140 16% 96% / .1);--lime:hsl(99 34% 65%);--lime-hover:hsl(99 36% 73%);--danger:hsl(351 95% 82%)}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;isolation:isolate;background:radial-gradient(ellipse 80% 55% at 50% -10%,hsl(99 34% 65% / .12),transparent 70%),var(--paper);color:var(--ink);font:16px/1.6 Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;z-index:-1;left:calc(50% - 550px);top:58%;width:1100px;height:1100px;border:1px solid hsl(99 34% 65% / .12);border-radius:50%;background:radial-gradient(ellipse at 50% 0%,hsl(99 34% 65% / .1),transparent 60%);box-shadow:0 -24px 100px hsl(99 34% 65% / .035);pointer-events:none}
.shell{min-height:100svh;display:grid;place-items:center;padding:48px 20px}
.panel{width:100%;max-width:480px;padding:36px;border:1px solid var(--line);border-radius:20px;background:hsl(160 8% 9% / .82);box-shadow:inset 0 1px 0 hsl(140 16% 96% / .04),0 50px 90px -30px hsl(0 0% 0% / .6);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 32px;font-size:27px;font-weight:750;line-height:1;letter-spacing:-.06em}
.brand .mark{width:36px;height:36px;flex:none;color:var(--lime)}
h1{margin:0 0 12px;font-size:32px;font-weight:600;line-height:1.1;letter-spacing:-.035em;text-wrap:balance}
p{margin:0}
.intro{color:var(--muted);max-width:44ch}
a{color:var(--lime);text-underline-offset:4px}
strong{font-weight:600;color:var(--ink)}
code{font:500 .9em ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.eyebrow{margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--lime)}
label{display:grid;gap:8px;margin:0 0 16px;font-size:14px;font-weight:500}
input:not([type=radio]):not([type=checkbox]){width:100%;min-height:48px;padding:11px 14px;border:1px solid hsl(140 16% 96% / .14);border-radius:9px;background:var(--field);color:var(--ink);font:inherit;font-size:16px}
input:not([type=radio]):not([type=checkbox]):hover{border-color:hsl(140 16% 96% / .28)}
input:not([type=radio]):not([type=checkbox]):focus{border-color:var(--lime)}
input[type=radio],input[type=checkbox]{accent-color:var(--lime);width:19px;height:19px;flex:none;margin:0;cursor:pointer}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:50px;padding:12px 26px;border:1px solid hsl(140 16% 96% / .15);border-radius:9px;background:hsl(160 8% 9% / .6);color:var(--ink);font:inherit;font-size:15px;font-weight:600;line-height:1.5;cursor:pointer;transition:background-color 160ms,border-color 160ms}
button:hover{background:hsl(140 16% 96% / .07);border-color:hsl(140 16% 96% / .8)}
button.primary{background:var(--lime);border-color:hsl(99 34% 65% / .75);color:var(--paper);box-shadow:inset 0 1px 0 hsl(140 16% 96% / .2),0 0 24px hsl(99 34% 65% / .08)}
button.primary:hover{background:var(--lime-hover);border-color:var(--lime)}
button.block{display:flex;width:100%}
button.link{min-height:0;padding:0;border:0;background:none;box-shadow:none;color:var(--lime);font-size:inherit;font-weight:500;text-decoration:underline;text-underline-offset:4px}
button:disabled{opacity:.55;cursor:wait}
form[aria-busy=true] button:disabled{opacity:.85;cursor:progress}
.spinner{width:16px;height:16px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 800ms linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
:focus-visible{outline:2px solid var(--lime);outline-offset:3px}
.error{color:var(--danger)}
.success{color:var(--lime)}
.symbol{display:grid;place-items:center;width:48px;height:48px;margin-bottom:22px;border-radius:50%;background:hsl(99 34% 65% / .12);color:var(--lime)}
.symbol.error{background:hsl(351 95% 82% / .12)}
.symbol svg{width:24px;height:24px}
.symbol .spinner{width:22px;height:22px}
.next-step{margin:28px 0 0;padding-left:16px;border-left:2px solid var(--lime);color:var(--muted)}
.next-step strong{display:block;margin-bottom:4px;font-size:15px}
.next-step p{font-size:14px}
.reassurance{margin:28px 0 0;padding-top:20px;border-top:1px solid var(--line);color:var(--subtle);font-size:13px;line-height:1.65}
[hidden]{display:none!important}
@media(max-width:560px){.shell{place-items:start center;padding:20px 16px}.panel{padding:28px 22px;border-radius:16px}.brand{margin-bottom:28px}h1{font-size:28px}}
@media(prefers-reduced-motion:reduce){button{transition:none}.spinner{animation-duration:2.4s}}
@media(forced-colors:active){button.primary{border-color:ButtonText}}
`;

// A form marked data-pending="<label>" hands off to a provider with a server
// redirect that can take several seconds; its button shows the label and a
// spinner until the next page loads, and a second submit is dropped. Returning
// through the back button restores the idle button. Pages allow this script by
// hash in their CSP.
const pendingSubmitSource = `document.querySelectorAll("form[data-pending]").forEach(function(form){var button=form.querySelector("button[type=submit]"),label=button.textContent,status=document.createElement("span");status.className="visually-hidden";status.setAttribute("role","status");form.append(status);addEventListener("pageshow",function(){form.removeAttribute("aria-busy");button.disabled=false;button.textContent=label;status.textContent=""});form.addEventListener("submit",function(event){if(form.hasAttribute("aria-busy")){event.preventDefault();return}var spinner=document.createElement("span");spinner.className="spinner";spinner.setAttribute("aria-hidden","true");form.setAttribute("aria-busy","true");button.disabled=true;button.replaceChildren(spinner,form.dataset.pending);status.textContent=form.dataset.pending})})`;
export const pendingSubmitScript = `<script>${pendingSubmitSource}</script>`;
export const PENDING_SUBMIT_SCRIPT_HASH = `sha256-${createHash("sha256").update(pendingSubmitSource).digest("base64")}`;

export interface LiftyPageOptions {
  /** Complete, already escaped document title. */
  title: string;
  /** Already escaped panel content, rendered below the brand. */
  content: string;
  styles?: string;
  /** Login pages load the same tab icon as the public Lifty site. */
  favicon?: boolean;
  /** Complete script elements, appended after the panel. */
  scripts?: string;
  /** Complete, already escaped extra head elements. */
  head?: string;
}

/** One branded panel on the public Lifty surface. */
export function renderLiftyPage(options: LiftyPageOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${options.title}</title>${options.head ?? ""}${options.favicon ? '<link rel="icon" href="/favicon.ico" sizes="32x32" type="image/x-icon">' : ""}<style>${liftyStyles}${options.styles ?? ""}</style></head><body><main class="shell"><div class="panel">${liftyBrand}${options.content}</div></main>${options.scripts ?? ""}</body></html>`;
}
