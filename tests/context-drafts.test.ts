import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CONTEXT_FILES, STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { nextStepGuide } from "../src/next-step.js";
import { profileFixture } from "./business-fixtures.js";
import { callStageMcpTool } from "../src/mcp-stage-tools.js";

// LIF-1298: a marked test workspace's drafts replace published context files
// in what its agent reads; every other caller, and any failed read, gets the
// published files from git.
const testWorkspace = "12980000-0000-4000-a000-00000000000a";
const draft = (file: string, content: string, revision = 3) =>
  ({ draft_ref: "12980000-0000-4000-a000-0000000000d1", file, revision, content });

function harness(drafts: unknown, options: { admin?: unknown } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    switch (name) {
      case "get_lifty_business_profile":
        return { data: { workspace: { workspace_ref: testWorkspace, name: "Test", state: "ready_for_connections" },
          profile: { ...profileFixture, confirmation: { complete: false, missing: ["offerings"] } } }, error: null };
      case "get_lifty_context_drafts":
        return drafts instanceof Error ? { data: null, error: { code: "XX000", message: drafts.message } }
          : { data: { workspace_ref: testWorkspace, drafts }, error: null };
      case "admin_list_lifty_context_drafts":
        return options.admin ?? { data: null, error: { code: "PT403", message: "ADMIN_REQUIRED" } };
      default: throw new Error(`Unexpected RPC ${name}`);
    }
  });
  const app = createApp({
    authenticate: async request => request.headers.get("authorization") === "Bearer founder"
      ? { ok: true, session: { userId: "founder", client: { rpc } } } : { ok: false, reason: "invalid_session" },
    log: () => {},
  });
  const get = (path: string, authorized = true) => app.request(path, { headers: {
    ...(authorized ? { authorization: "Bearer founder" } : {}), "x-lifty-client-contract": STAGE_CLIENT_CONTRACT } });
  return { app, get, calls };
}

describe("context drafts", () => {
  it("serves a test workspace's draft in next_step and the published guide otherwise", async () => {
    const published = nextStepGuide("business_confirmation_needed")!;
    const withDraft = await (await harness([draft("business", "# Draft business guide")]).get("/v1/workspace/next-step")).json();
    expect(withDraft.reason).toBe("business_confirmation_needed");
    expect(withDraft.guide.instructions.startsWith("# Draft business guide\n## business operations")).toBe(true);
    expect(withDraft.guide.drafts).toEqual([{ draft_ref: draft("business", "").draft_ref, file: "business", revision: 3 }]);
    expect(withDraft.guide.revision).not.toBe(published.revision);

    // A draft of a file this step does not inline, of a retired file, or a
    // failed read all leave the published guide byte for byte.
    for (const drafts of [[draft("configuration", "# Unused here")], [draft("retired-guide", "# Gone")], new Error("private failure")]) {
      const response = await harness(drafts).get("/v1/workspace/next-step");
      expect(response.status).toBe(200);
      expect((await response.json()).guide).toEqual(published);
    }
  });

  it("applies drafts to a full context read only for a caller with a session", async () => {
    const h = harness([draft("interview", "# Draft interview")]);
    const anonymous = await (await h.get("/v1/context/business", false)).json();
    expect(anonymous).toEqual(getAgentContext("business"));
    expect(h.calls).not.toContain("get_lifty_context_drafts");

    const signedIn = await (await h.get("/v1/context/business")).json();
    expect(signedIn.references.interview).toBe("# Draft interview");
    expect(signedIn.instructions).toBe(getAgentContext("business")!.instructions);
    expect(signedIn.drafts).toEqual([{ draft_ref: draft("interview", "").draft_ref, file: "interview", revision: 3 }]);
    expect(signedIn.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(signedIn.revision).not.toBe(anonymous.revision);

    const mcp = await callStageMcpTool("summary_context", { path: { task: "business" } },
      new Request("https://example.test/mcp", { headers: { authorization: "Bearer founder" } }),
      (route, init) => Promise.resolve(h.app.request(route, init)));
    expect(mcp.structuredContent.data).toMatchObject({
      references: { interview: "# Draft interview" }, drafts: signedIn.drafts, schemas: {},
    });
    expect((mcp.structuredContent.data as Record<string, unknown>).revision).not.toBe(signedIn.revision);
  });

  it("gives admins every published file with its hash, and marks drafts whose file changed since", async () => {
    const stale = { draft_ref: "12980000-0000-4000-a000-0000000000d2", file: "targeting", workspace_ref: testWorkspace,
      status: "active", revision: 1, base_sha256: "a".repeat(64), content: "# Old base", created_by: null,
      created_at: "2026-10-06T00:00:00Z", closed_by: null, closed_at: null, promoted_revision: null, pull_request_url: null,
      revisions: [{ revision: 1, base_sha256: "a".repeat(64), size: 10, actor: null, recorded_at: "2026-10-06T00:00:00Z" }] };
    const current = { ...stale, draft_ref: "12980000-0000-4000-a000-0000000000d3", file: "business",
      base_sha256: createHash("sha256").update(CONTEXT_FILES.business!, "utf8").digest("hex") };
    const admin = harness([], { admin: { data: { test_workspaces: [], drafts: [stale, current] }, error: null } });
    const response = await admin.get("/v1/admin/context");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files.map((file: { file: string }) => file.file)).toEqual(Object.keys(CONTEXT_FILES));
    const business = body.files.find((file: { file: string }) => file.file === "business");
    expect(business).toMatchObject({ sha256: current.base_sha256, content: CONTEXT_FILES.business });
    expect(business.used_by).toContainEqual({ task: "business", as: "instructions" });
    expect(body.drafts.map((item: { file: string; stale: boolean }) => [item.file, item.stale])).toEqual([["targeting", true], ["business", false]]);

    expect((await harness([]).get("/v1/admin/context")).status).toBe(403);
  });
});
