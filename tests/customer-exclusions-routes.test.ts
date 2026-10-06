import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { callStageMcpTool, getStageMcpTools } from "../src/mcp-stage-tools.js";
// Captured by Functions scripts/test-lif1082-customer-exclusions.py after a
// clean migration replay: both authenticated RPCs return the complete status.
import sqlReceipt from "./customer-exclusions-sql-fixture.json" with { type: "json" };

const workspace = "22222222-2222-4222-8222-222222222222";
const receipt = {
  workspace_ref: workspace, revision: "a".repeat(64), imported_at: "2026-10-06T11:42:00+00:00", candidates_excluded: 17, domain_count: 2, email_count: 3,
  uploaded_domain_count: 2, uploaded_email_count: 3,
  accepted_rows: 5, rejected_count: 4,
  rejected_rows: [
    { row: 6, reason: "invalid_domain" }, { row: 7, reason: "free_mail_domain" },
    { row: 8, reason: "missing_identity" }, { row: 9, reason: "invalid_domain" },
  ],
  added_domains: 2, removed_domains: 0, added_emails: 3, removed_emails: 0,
};
const csv = 'domain,email,name\r\nHTTPS://WWW.Customer.Example/path,VIP@Customer.Example,"Doe, Jane"\r\ncustomer.example.,vip@customer.example,Duplicate\r\nGMAIL.COM,Founder+test@Gmail.com,Free mail\r\n,Existing@Sub.Business.Example,\r\nbad domain,broken@@example.com,\r\ngmail.com,,\r\n,,\r\nrelativeonly,person@business.example,\r\nanother.example,,\r\n';
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc = name => name.startsWith("get_") ? { ...receipt, candidates_excluded: 17 } : receipt) {
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const provider = vi.fn();
  const app = createApp({
    authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), log: () => {},
    enqueueFirstRun: provider, startHubspotConnect: provider, startAttioConnect: provider,
  });
  const headers = { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" };
  const read = (query = "") => app.request(`/v1/workspace/customer-exclusions${query}`, { headers });
  const upload = (body: unknown) => app.request("/v1/workspace/customer-exclusions/import", {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, read, upload, client, provider };
}

describe("customer exclusion file import", () => {
  it("normalizes, deduplicates, protects free-mail people exactly and reports rejected row numbers", async () => {
    const h = harness();
    const response = await h.upload({ csv });
    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([200, "no-store", receipt]);
    expect(h.client.rpc).toHaveBeenCalledWith("replace_workspace_customer_exclusions", {
      p_workspace: null, p_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_domains: ["another.example", "customer.example"],
      p_emails: ["existing@sub.business.example", "founder+test@gmail.com", "vip@customer.example"],
      p_accepted_rows: 5, p_rejected_rows: receipt.rejected_rows,
    });
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("reuses the normalized revision on retry and supports aliases, quoted fields and explicit clearing", async () => {
    const h = harness();
    const file = '\ufeffCompany Domain,Email Address,Company\n"https://www.customer.example","VIP@Customer.Example","First\nCompany"\n';
    expect((await h.upload({ csv: file })).status).toBe(200);
    expect((await h.upload({ csv: file })).status).toBe(200);
    expect(h.client.rpc.mock.calls[0]?.[1]).toEqual(h.client.rpc.mock.calls[1]?.[1]);
    expect((await h.upload({ csv: "website,email\n" })).status).toBe(200);
    expect(h.client.rpc.mock.lastCall?.[1]).toMatchObject({ p_domains: [], p_emails: [], p_accepted_rows: 0, p_rejected_rows: [] });
  });

  it("accepts a bounded CSV whose quoted cells expand beyond the ordinary JSON request limit", async () => {
    const h = harness();
    const file = `domain,name\ncustomer.example,"${'""'.repeat(35000)}"\n`;
    expect((await h.upload({ csv: file })).status).toBe(200);
    expect(h.client.rpc.mock.lastCall?.[1]).toMatchObject({ p_domains: ["customer.example"], p_emails: [], p_accepted_rows: 1 });
  });

  it("rejects malformed records in full without echoing private customer cells", async () => {
    const h = harness();
    const response = await h.upload({ csv: 'website,email\nlegit.example,broken@@private.example\n"customer.example"junk,person@private.example\nother.example,person@private.example,extra\nsafe.example,\n' });
    expect(response.status).toBe(200);
    expect(h.client.rpc.mock.lastCall?.[1]).toMatchObject({
      p_domains: ["safe.example"], p_emails: [], p_accepted_rows: 1,
      p_rejected_rows: [{ row: 2, reason: "invalid_email" }, { row: 3, reason: "malformed_csv" }, { row: 4, reason: "column_count" }],
    });
    expect((await response.text())).not.toContain("private.example");
  });

  it.each([
    ["missing a recognized header", { csv: "company\nExample\n" }, 422],
    ["an unterminated quote", { csv: 'domain\n"customer.example' }, 422],
    ["an empty file", { csv: "" }, 422],
    ["only invalid rows", { csv: "email\nbroken@@private.example\n" }, 422],
    ["a quoted empty customer record", { csv: 'email\n""\n' }, 422],
    ["a foreign workspace field", { csv: "domain\ncustomer.example", workspace_ref: workspace }, 422],
    ["an oversized CSV", { csv: `domain\n${"x".repeat(128 * 1024)}` }, 413],
    ["too many records", { csv: `domain\n${"a.test\n".repeat(5001)}` }, 413],
  ] as const)("rejects %s before replacing the saved list", async (_name, body, status) => {
    const h = harness();
    const response = await h.upload(body);
    expect(response.status).toBe(status);
    expect(h.client.rpc).not.toHaveBeenCalled();
  });

  it("authenticates imports before parsing a private file", async () => {
    const app = createApp();
    const response = await app.request("/v1/workspace/customer-exclusions/import", { method: "POST", body: csv });
    expect(response.status).toBe(401);
  });
});

describe("customer exclusion status and transport", () => {
  it("transports the real SQL GET and replacement receipts without losing their metadata", async () => {
    const h = harness(name => name.startsWith("get_") ? sqlReceipt.get : sqlReceipt.replace);
    const read = await h.read();
    expect([read.status, await read.json()]).toEqual([200, sqlReceipt.get]);
    const replaced = await h.upload({ csv });
    expect([replaced.status, await replaced.json()]).toEqual([200, sqlReceipt.replace]);
  });

  it("reads the selected workspace's counts and latest rejected rows without calling providers", async () => {
    const h = harness();
    const response = await h.read();
    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([200, "no-store", { ...receipt, candidates_excluded: 17 }]);
    expect(h.client.rpc).toHaveBeenCalledExactlyOnceWith("get_workspace_customer_exclusions", { p_workspace: null });
    expect(h.provider).not.toHaveBeenCalled();
    expect((await h.read(`?workspace_ref=${workspace}`)).status).toBe(400);
    expect(h.client.rpc).toHaveBeenCalledTimes(1);
  });

  it.each(["get_workspace_customer_exclusions", "replace_workspace_customer_exclusions"])("maps a foreign workspace denial at %s without exposing data", async rpcName => {
    const h = harness(() => { throw { code: "PT403", message: "lifty_workspace_forbidden", details: "private foreign workspace" }; });
    const response = rpcName.startsWith("get_") ? await h.read() : await h.upload({ csv });
    expect(response.status).toBe(403);
    expect((await response.text())).not.toContain("private foreign workspace");
  });

  it.each([
    ["CUSTOMER_EXCLUSIONS_TOO_LARGE", "PT422", 422],
    ["CUSTOMER_EXCLUSIONS_REVISION_CONFLICT", "PT409", 409],
  ] as const)("returns the database's typed %s import error", async (code, dbCode, status) => {
    const h = harness(() => { throw { code: dbCode, message: code }; });
    const response = await h.upload({ csv });
    expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
  });

  it.each([null, { ...receipt, candidates_excluded: -1 }, { code: "PGRST202", message: "private database detail" }])("fails closed on an unavailable status", async result => {
    const h = harness(() => {
      if (result && "code" in result) throw result;
      return result;
    });
    const response = await h.read();
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe("CUSTOMER_EXCLUSIONS_UNAVAILABLE");
    expect(body).not.toContain("private database detail");
  });

  it("publishes the same status/import contracts to CLI, MCP and OpenAPI", async () => {
    const h = harness();
    const context = getAgentContext("customer-exclusions")!;
    expect(Object.entries(context.operations!).map(([key, op]) => [key, op.method, op.cli?.operation, op.route])).toEqual([
      ["status", "GET", "status", "/v1/workspace/customer-exclusions"],
      ["import", "POST", "import", "/v1/workspace/customer-exclusions/import"],
    ]);
    const tools = Object.fromEntries(getStageMcpTools().map(tool => [tool.name, tool]));
    expect(tools.customer_exclusions_status?.annotations.readOnlyHint).toBe(true);
    expect(tools.customer_exclusions_import?.description).toContain("Writes commit synchronously");
    const result = await callStageMcpTool("customer_exclusions_status", { workspace: "example" }, new Request("https://api.example/mcp", {
      headers: { authorization: "Bearer session" },
    }), async (route, init) => h.app.request(route, init));
    expect(result.structuredContent).toEqual({ status: 200, data: { ...receipt, candidates_excluded: 17 } });
    const openapi = await (await h.app.request("/openapi.json")).json();
    expect(openapi.paths["/v1/workspace/customer-exclusions/import"].post.requestBody.content["application/json"].schema.properties.csv.type).toBe("string");
  });
});
