import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { newSetupSecret, type WarmupSetup } from "./warmup-setup.js";
import { renderWarmupReceipt, renderWarmupSetupPage, WARMUP_SETUP_SCRIPT_HASH } from "./warmup-setup-page.js";
import { PublicError } from "./errors.js";

export function createWarmupSetupRouter(setup:WarmupSetup) {
  const app = new Hono();
  const secure = new URL(setup.origin).protocol === "https:";
  const cookieName = secure ? "__Host-lifty-warmup-browser" : "lifty-warmup-browser";
  const error = (c:Context, status:ContentfulStatusCode, message:string) => c.html(renderWarmupReceipt("Setup needs attention", message), status);
  app.use("*", async(c,next)=>{
    c.header("cache-control","no-store, no-transform"); c.header("referrer-policy","no-referrer"); c.header("x-content-type-options","nosniff");
    c.header("content-security-policy",`default-src 'none'; style-src 'unsafe-inline'; script-src '${WARMUP_SETUP_SCRIPT_HASH}'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'`);
    await next();
  });
  // Deliberately no exception, query, request body or OAuth response logging.
  app.onError((e,c)=>error(c, e instanceof PublicError ? e.status as ContentfulStatusCode : 500,
    e instanceof PublicError ? e.message : "Lifty could not complete setup. Return to your agent to check warmup status."));
  app.get("/setup",async c=>{
    // no-referrer makes some browsers send Origin:null on a form POST.
    // same-origin keeps the POST origin check usable without leaking the link to Google/Mailivery.
    c.header("referrer-policy","same-origin");
    const params = new URL(c.req.url).searchParams;
    if (params.getAll("intent").length !== 1 || [...params.keys()].some(key=>key!=="intent")) return error(c,400,"Open the setup link from Lifty.");
    const intent = params.get("intent")!;
    const record = await setup.read(intent);
    const previous = getCookie(c,cookieName);
    const csrf = previous && /^[A-Za-z0-9_-]{43}$/.test(previous) ? previous : newSetupSecret();
    setCookie(c,cookieName,csrf,{httpOnly:true,secure,sameSite:"Lax",path:"/",maxAge:3600});
    return c.html(renderWarmupSetupPage(record,intent,csrf));
  });
  app.post("/setup",async c=>{
    if (c.req.header("origin") !== setup.origin || c.req.header("sec-fetch-site") === "cross-site") return error(c,403,"Submit this form from the Lifty setup page.");
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return error(c,400,"Submit the setup form.");
    const reader = c.req.raw.body?.getReader();
    if (!reader) return error(c,400,"Submit the setup form.");
    const chunks:Uint8Array[]=[]; let size=0;
    try {
      while (true) { const chunk=await reader.read(); if(chunk.done)break; size+=chunk.value.byteLength;
        if(size>8192){await reader.cancel();return error(c,413,"The setup form is too large.");} chunks.push(chunk.value); }
    } finally {reader.releaseLock();}
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const cookie = getCookie(c,cookieName) ?? "", csrf = form.get("csrf") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(cookie) || !/^[A-Za-z0-9_-]{43}$/.test(csrf)
      || !timingSafeEqual(Buffer.from(cookie),Buffer.from(csrf))) return error(c,403,"Reopen the Lifty setup link in this browser.");
    const keys=["intent","csrf","first_name","last_name","timezone"];
    if(keys.some(key=>form.getAll(key).length!==1)||[...form.keys()].some(key=>!keys.includes(key))) return error(c,400,"Submit each setup field once.");
    const target = await setup.choose(form.get("intent")!,cookie,{first_name:form.get("first_name"),last_name:form.get("last_name"),timezone:form.get("timezone")});
    return c.redirect(target,303);
  });
  app.get("/google/callback",async c=>{
    const params=new URL(c.req.url).searchParams;
    if(params.has("error"))return error(c,400,"Google authorization was not completed. No tokens were sent to Mailivery. Run warmup start to try again.");
    if(params.getAll("code").length!==1||params.getAll("state").length!==1) return error(c,400,"Google authorization could not be verified.");
    await setup.callback(params.get("state")!,getCookie(c,cookieName)??"",params.get("code")!);
    deleteCookie(c,cookieName,{path:"/",secure,httpOnly:true,sameSite:"Lax"});
    return c.redirect("../received",303);
  });
  app.get("/received",c=>c.html(renderWarmupReceipt()));
  return app;
}
