import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("outreach writing context", () => {
  it("supplies the same versioned public playbook through both campaign entry points without reading private state", async () => {
    const never = async () => { throw new Error("Writing guidance must not load tenant data or execution prompts"); };
    const app = createApp({ authenticate: never, getWorkspace: never,
      getOnboardingContext: never, getConfig: never, getConfigUpdateContext: never });
    const playbooks: string[] = [];
    const antiSlopLists: string[] = [];
    for (const task of ["campaign", "campaigns"]) {
      const response = await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v5`);
      expect(response.status).toBe(200);
      const context = await response.json();
      expect(context.references.writing).toEqual(expect.any(String));
      expect(context.references.writing).toMatch(/^# LIFT outreach writing guide\n\nVersion: lifty-writing\.v3\n/);
      expect(context.references.writing).toContain("Email shape");
      expect(context.references.writing).toContain("Subject line");
      expect(context.references.writing).toContain("same subject line on all five steps");
      expect(context.references.writing).toContain("Emails 1-2 focus on a pain");
      expect(context.references.writing).toContain("Emails 3-4 focus on the founder's product");
      expect(context.references.writing).toContain("the better person");
      expect(context.references.writing).toContain("must name the same job");
      expect(context.references.writing).toContain("one connected thought");
      expect(context.references.writing).toContain("Name the author");
      expect(context.references.writing).toContain("{{first_name}}");
      expect(context.references.writing).toContain("I'm asking");
      expect(context.references.anti_slop).toEqual(expect.any(String));
      expect(context.references.anti_slop).toMatch(/^# LIFT outreach anti-slop list\n\nVersion: lifty-anti-slop\.v1\n/);
      expect(context.references.anti_slop).toContain("quick question");
      expect(context.references.anti_slop).toContain("I don't want to keep asking you");
      playbooks.push(context.references.writing);
      antiSlopLists.push(context.references.anti_slop);
    }
    expect(playbooks[0]).toBe(playbooks[1]);
    expect(antiSlopLists[0]).toBe(antiSlopLists[1]);
  });
});
