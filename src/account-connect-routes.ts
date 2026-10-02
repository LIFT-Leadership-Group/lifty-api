import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createConfirmationRouter, type ConfirmationLog } from "./connection-confirmation.js";
import type { AccountConnection, ConnectOutcome } from "./account-connection.js";
import { renderConnectMessagePage, renderConnectPage } from "./connect-page.js";
import { hostedReturnError } from "./hosted-return-error.js";
import { PENDING_SUBMIT_SCRIPT_HASH } from "./lifty-brand.js";
import { PublicError } from "./errors.js";
import type { ConnectChannel } from "./connect-state.js";

const MAX_FORM_BYTES = 4096;
const fields: Record<ConnectChannel, string[]> = {
  email: ["intent", "mailbox_use"],
  linkedin: ["intent", "habitual_personal_account", "no_other_automation"],
};

/** Lifty's connect page and the shared confirmation shell for both channels. */
export function createAccountConnectRouter(connection: AccountConnection,
  options: { origin: string; hostedOrigins: string[]; log?: (event: ConfirmationLog) => void }) {
  const app = new Hono();
  const message = (c: Context, status: ContentfulStatusCode, title: string, text: string) =>
    c.html(renderConnectMessagePage(title, text), status);
  const render = (c: Context, channel: ConnectChannel, intent: string, outcome: ConnectOutcome) => {
    if (outcome.kind === "redirect") return c.redirect(outcome.url, 303);
    if (outcome.kind === "checking") return c.redirect(`/connect/${channel}/return?intent=${encodeURIComponent(intent)}`, 303);
    return c.html(renderConnectPage(channel, intent, outcome.senderName));
  };
  app.use("/connect/*", async (c, next) => {
    c.header("cache-control", "no-store, no-transform"); c.header("x-content-type-options", "nosniff");
    // same-origin keeps the form's Origin check usable without leaking the link to the provider.
    c.header("referrer-policy", "same-origin");
    c.header("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; script-src '${PENDING_SUBMIT_SCRIPT_HASH}'; form-action 'self' ${options.hostedOrigins.join(" ")}; base-uri 'none'; frame-ancestors 'none'`);
    await next();
  });
  // Never log intents, provider URLs or bodies; the page shows a safe next step.
  app.onError((error, c) => error instanceof PublicError && error.status < 500
    ? message(c, error.status as ContentfulStatusCode, "Connection needs attention", error.message)
    : message(c, 503, "Connection unavailable", "Lifty could not open the sign-in right now. Try the same link again shortly."));

  for (const channel of ["email", "linkedin"] as const) {
    app.get(`/connect/${channel}`, async c => {
      const params = new URL(c.req.url).searchParams;
      if (params.getAll("intent").length !== 1 || [...params.keys()].some(key => key !== "intent")) {
        return message(c, 400, "Connection needs attention", "Open the connection link from Lifty.");
      }
      const intent = params.get("intent")!;
      return render(c, channel, intent, await connection.page(channel, intent));
    });
    app.post(`/connect/${channel}`, async c => {
      if (c.req.header("origin") !== options.origin || c.req.header("sec-fetch-site") === "cross-site") {
        return message(c, 403, "Connection needs attention", "Continue from the Lifty connection page.");
      }
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        return message(c, 400, "Connection needs attention", "Submit the connection form.");
      }
      const reader = c.req.raw.body?.getReader();
      if (!reader) return message(c, 400, "Connection needs attention", "Submit the connection form.");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
          if (size > MAX_FORM_BYTES) { await reader.cancel(); return message(c, 413, "Connection needs attention", "The form is too large."); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const keys = fields[channel];
      if (keys.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !keys.includes(key))) {
        return message(c, 400, "Connection needs attention", channel === "email"
          ? "Say how you use this mailbox before continuing." : "Confirm both statements before continuing.");
      }
      const intent = form.get("intent")!;
      if (channel === "email") {
        const use = form.get("mailbox_use");
        if (use !== "habitual" && use !== "dedicated") return message(c, 400, "Connection needs attention", "Say how you use this mailbox before continuing.");
        return render(c, channel, intent, await connection.declare(channel, intent, { mailbox_use: use }));
      }
      if (form.get("habitual_personal_account") !== "yes" || form.get("no_other_automation") !== "yes") {
        return message(c, 400, "Connection needs attention", "Confirm both statements before continuing.");
      }
      return render(c, channel, intent, await connection.declare(channel, intent, { habitual_personal_account: true, no_other_automation: true }));
    });
    app.route("/", createConfirmationRouter(channel, {
      validate: input => { connection.validate(channel, input.state); },
      // The provider returns without a code; status alone reads/reconciles the attempt.
      status: input => connection.confirm(channel, input.state, hostedReturnError(input.errorType)),
    }, { origin: options.origin, ...(options.log ? { log: options.log } : {}) }));
  }
  return app;
}
