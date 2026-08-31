import { describe, expect, it } from "vitest";

import { renderCliAuthPage } from "../src/cli-auth-page.js";

describe("DigitalOcean CLI auth page", () => {
  it("embeds only public auth configuration and a fixed loopback callback", () => {
    const state = "state_nonce-123";
    const html = renderCliAuthPage({
      supabaseUrl: "https://project.supabase.test",
      publishableKey: "sb_publishable_public",
      state,
      port: 49152,
      scriptNonce: "nonce-for-test",
    });

    expect(html).toContain("Sign in to LIFTY");
    expect(html).toContain("Create account");
    expect(html).toContain("https://project.supabase.test");
    expect(html).toContain("sb_publishable_public");
    expect(html).toContain("http://127.0.0.1:49152/callback");
    expect(html).toContain(state);
    expect(html).not.toMatch(/client[_-]?secret|service[_-]?role/i);
    expect(html).not.toContain("localhost");
  });

  it("escapes embedded values so public configuration cannot break the script", () => {
    const html = renderCliAuthPage({
      supabaseUrl: "https://project.supabase.test",
      publishableKey: "sb_publishable_</script><script>alert(1)</script>",
      state: "safe-state",
      port: 49152,
      scriptNonce: "nonce-for-test",
    });

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
