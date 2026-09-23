import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createWarmupSetupRouter } from "../src/warmup-setup-routes.js";
import type { WarmupSetup } from "../src/warmup-setup.js";
import { WARMUP_SETUP_SCRIPT_HASH } from "../src/warmup-setup-page.js";
const token = "a".repeat(43);
function harness() {
  const setup:WarmupSetup = {origin:"https://api.lifty.test", issue:vi.fn(),
    read:vi.fn(async () => ({email:"ada@example.test", workspace_ref:"22222222-2222-4222-8222-222222222222",
      sender_ref:"33333333-3333-4333-8333-333333333333", state:"draft" as const, expires_at:"2026-10-01T00:00:00Z", policy:null,first_name:"",last_name:""})),
    choose:vi.fn(async()=>"https://accounts.google.com/o/oauth2/v2/auth?state=not-a-secret"), callback:vi.fn()};
  return {setup, app:createWarmupSetupRouter(setup)};
}
it("shows only the mailbox, name fields and one Google button, with protected browser cookies/headers", async () => {
  const {app} = harness();
  const res = await app.request(`https://api.lifty.test/setup?intent=${token}`);
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(html).toContain("ada@example.test");
  expect(html).toContain("Continue with Google");
  expect(html).not.toMatch(/type="password"|name="email"|name="method"|name="emails_per_day"|name="reply_rate"|App Password|Unipile/);
  expect(html).toMatch(/name="timezone" id="tz" value="America\/New_York"/);
  expect(res.headers.get("set-cookie")).toMatch(/__Host-lifty-warmup-browser=.+HttpOnly.+Secure.+SameSite=Lax/);
  expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain(`script-src '${WARMUP_SETUP_SCRIPT_HASH}'`);
  expect(csp).not.toContain("mailivery");
  const script = html.match(/<script>([^<]*)<\/script>/)?.[1];
  expect(`sha256-${createHash("sha256").update(script ?? "").digest("base64")}`).toBe(WARMUP_SETUP_SCRIPT_HASH);
});
it("rejects cross-origin and missing cookie without changing setup", async () => {
  const {app, setup} = harness();
  for (const origin of ["https://evil.test", "https://api.lifty.test"]) {
    const res = await app.request("https://api.lifty.test/setup", {method:"POST", headers:{origin,"content-type":"application/x-www-form-urlencoded"}, body:`intent=${token}&csrf=${token}`});
    expect(res.status).toBe(403);
  }
  expect(setup.choose).not.toHaveBeenCalled();
});
it("posts only name and browser timezone from a valid browser and rejects duplicate/unknown fields",async()=>{
  const {app,setup}=harness();
  const headers={origin:"https://api.lifty.test","content-type":"application/x-www-form-urlencoded",cookie:`__Host-lifty-warmup-browser=${token}`};
  const form=new URLSearchParams({intent:token,csrf:token,first_name:"Ada",last_name:"",timezone:"Europe/Madrid"});
  for(const extra of ["&method=app_password","&emails_per_day=100","&timezone=UTC","&email=other@example.test","&google_token=PRIVATE"]){
    const denied=await app.request("https://api.lifty.test/setup",{method:"POST",headers,body:form+extra});
    expect(denied.status).toBe(400);
  }
  expect(setup.choose).not.toHaveBeenCalled();
  const res=await app.request("https://api.lifty.test/setup",{method:"POST",headers,body:form});
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toMatch(/^https:\/\/accounts.google.com/);
  expect(setup.choose).toHaveBeenCalledWith(token,token,{first_name:"Ada",last_name:"",timezone:"Europe/Madrid"});
});
it("mounts browser routes before API auth without logging callback bodies or codes",async()=>{
  const {setup}=harness();
  const log=vi.fn(),authenticate=vi.fn(async()=>{throw Error("must not authenticate browser callback as CLI");});
  const app=createApp({warmupSetup:setup,authenticate,log});
  const res=await app.request(`https://api.lifty.test/warmup/google/callback?state=${token}&code=PRIVATE_CODE`,{headers:{cookie:`__Host-lifty-warmup-browser=${token}`}});
  expect(res.status).toBe(303); expect(res.headers.get("location")).toBe("../received");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(setup.callback).toHaveBeenCalledWith(token,token,"PRIVATE_CODE");
  expect(authenticate).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
});
it("never echoes authorization codes or provider callback errors", async () => {
  const {app,setup} = harness();
  const res = await app.request(`https://api.lifty.test/google/callback?state=${token}&error=REFRESH_PRIVATE&error_description=PRIVATE`);
  expect(res.status).toBe(400);
  expect(await res.text()).not.toContain("PRIVATE");
  expect(setup.callback).not.toHaveBeenCalled();
});
