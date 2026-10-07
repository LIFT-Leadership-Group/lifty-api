import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { parseAntiSlopMarkdown } from "../src/generated/anti-slop.js";
import { refreshWritingRules, setWritingRules } from "../src/writing-rules.js";
import { campaign, campaignRef, policy, revision, workspace } from "./outreach-fixtures.js";

// Lifty reads the one banned-phrase list Jobs composes against (the database
// rulebook), and reports its phrases in saved templates without blocking.
const rulebook = "# Anti-Slop Rules\n\n## Global\n\n- i'm guessing\n- it looks like\n\n## Email\n\n- quick question\n\n## LinkedIn\n\n- last note from me\n";
const live = () => setWritingRules({ rules: parseAntiSlopMarkdown(rulebook), updatedAt: "2026-10-07T12:00:00Z" });

afterEach(() => setWritingRules(null));

describe("shared writing rules", () => {
  it("the generated matcher is the exact Jobs source recorded in its manifest", async () => {
    const [row] = JSON.parse(await readFile(new URL("../src/generated/anti-slop.manifest.json", import.meta.url), "utf8")) as
      Array<{ target: string; generated_sha256: string }>;
    const generated = await readFile(new URL(`../${row!.target}`, import.meta.url), "utf8");
    expect(createHash("sha256").update(generated).digest("hex")).toBe(row!.generated_sha256);
  });

  it("serves the live list in the campaign context and says so when it is unknown", () => {
    expect(getAgentContext("campaigns")!.references.anti_slop).toContain("The shared list could not be read right now.");
    live();
    const served = getAgentContext("campaigns")!.references.anti_slop!;
    expect(served).toContain("## Global\n\n- i'm guessing\n- it looks like");
    expect(served).toContain("## LinkedIn\n\n- last note from me");
    expect(served).not.toContain("could not be read");
  });

  it("keeps the last known list when a refresh fails", async () => {
    const ok = vi.fn(async () => Response.json({ anti_slop: { markdown: rulebook, updated_at: "2026-10-07T12:00:00Z" } }));
    expect(await refreshWritingRules({ supabaseUrl: "https://db.example", publishableKey: "pk", fetchImpl: ok })).toBe(true);
    expect(ok).toHaveBeenCalledWith("https://db.example/rest/v1/rpc/get_lifty_writing_rules", expect.objectContaining({ method: "POST" }));
    for (const failure of [async () => new Response("", { status: 500 }), async () => Response.json(null),
      async () => { throw new Error("offline"); }]) {
      expect(await refreshWritingRules({ supabaseUrl: "https://db.example", publishableKey: "pk", fetchImpl: failure })).toBe(false);
    }
    expect(getAgentContext("campaigns")!.references.anti_slop).toContain("- i'm guessing");
  });

  it("returns phrases found in the draft's templates as recommendations, without blocking the save", async () => {
    const templates = { ...policy, compose_mode: "templates",
      steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hi {first_name}, I'm guessing the timing is off." } }] };
    const saved = { ...campaign, draft_revision: revision(templates), revisions: [revision(templates)] };
    const rpc = vi.fn(async () => ({ data: { workspace, campaign: saved }, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const read = () => app.request(`/v1/workspace/campaigns/${campaignRef}`, { headers: { authorization: "Bearer test",
      "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" } });

    const unknown = await read();
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).not.toHaveProperty("writing_recommendations");

    live();
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).writing_recommendations).toEqual({ revision_ref: saved.draft_revision.revision_ref,
      phrases: [{ position: 1, template: null, field: "text", phrase: "i'm guessing" }] });
  });
});
