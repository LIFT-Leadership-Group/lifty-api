import { describe, expect, it } from "vitest";
import { renderEmailAuthorizationPage, renderEmailAuthorizationReceivedPage } from "../src/email-authorization-page.js";

describe("email authorization renderer", () => {
  it.each([false, true])("escapes signed state without changing the form contract (chooser=%s)", chooseProvider => {
    const html = renderEmailAuthorizationPage('state\"\'><script>alert(1)</script>&', chooseProvider);
    expect(html).toContain('<form method="post" action="/unipile/start">');
    expect(html).toContain('name="intent" value="state&quot;&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;"');
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/<input type="checkbox" name="mailbox_use" value="personal" required>/);
    expect(html).not.toMatch(/<script\b|<link\b|<iframe\b|https?:\/\//i);
  });

  it("keeps provider selection optional for retained connections and required for fresh connections", () => {
    const retained = renderEmailAuthorizationPage("signed-state");
    expect(retained).not.toContain('name="email_provider"');
    const fresh = renderEmailAuthorizationPage("signed-state", true);
    expect(fresh.match(/name="email_provider"/g)).toHaveLength(3);
    for (const value of ["google", "outlook", "imap"]) {
      expect(fresh).toMatch(new RegExp(`<input type="radio" name="email_provider" value="${value}"[^>]* required>`));
    }
    expect(fresh).not.toMatch(/<input[^>]*\bchecked\b/);
  });

  it("acknowledges receipt without offering replay or claiming a connected account", () => {
    const html = renderEmailAuthorizationReceivedPage();
    expect(html).toContain("We received your authorization");
    expect(html).not.toContain("still needs to be verified");
    expect(html).toContain("Return to your agent to check your connection status.");
    expect(html).not.toMatch(/<form\b|<input\b|<button\b|account is connected|successfully connected/i);
  });
});
