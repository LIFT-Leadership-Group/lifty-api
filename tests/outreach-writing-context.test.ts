import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("outreach writing context", () => {
  it("supplies the same versioned public playbook through both campaign entry points without reading private state", async () => {
    const never = async () => { throw new Error("Writing guidance must not load tenant data or execution prompts"); };
    const app = createApp({ authenticate: never, getWorkspace: never,
      getOnboardingContext: never, getConfig: never, getConfigUpdateContext: never });
    const playbooks: string[] = [];
    for (const task of ["campaign", "campaigns"]) {
      const response = await app.request(`/v1/context/${task}?client_contract=lifty-cli-context.v5`);
      expect(response.status).toBe(200);
      const context = await response.json();
      expect(context.references.writing).toEqual(expect.any(String));
      expect(context.references.writing).toMatch(/^# LIFT outreach writing guide\n\nVersion: lifty-writing\.v1\n/);
      playbooks.push(context.references.writing);

    }
    expect(playbooks[0]).toBe(playbooks[1]);
  });
});
