import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { getOnboardingContext, submitOnboarding } from "../src/workspace-operations.js";
import { localConfiguration, onboardingContext, confirmedDraft } from "./onboarding-fixtures.js";

const session = { userId: "founder", client: {} };
const authenticate = async () => ({ ok: true as const, session });
const draft = confirmedDraft;

function push(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/v1/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("locally generated onboarding", () => {
  it.each(["v4", "v5"])("requires explicit discovery intent from a %s client before saving a draft", async version => {
    const submit = vi.fn(); const enqueue = vi.fn();
    const app = createApp({ authenticate, submitOnboarding: submit, enqueueOnboardingImport: enqueue, getOnboardingContext: async () => onboardingContext });
    const response = await app.request("/v1/onboarding", { method: "POST",
      headers: { "content-type": "application/json", "x-lifty-client-contract": `lifty-cli-context.${version}` },
      body: JSON.stringify({ draft: { ...draft, icp: undefined }, configuration: localConfiguration }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.issues).toContainEqual(expect.objectContaining({ code: "discovery_intent_required", path: "/draft/icp/discovery" }));
    expect(submit).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([undefined, null])("requires local configuration before persisting or enqueuing (%s)", async (configuration) => {
    const submit = vi.fn();
    const enqueue = vi.fn();
    const app = createApp({ authenticate, submitOnboarding: submit, enqueueOnboardingImport: enqueue });
    const response = await push(app, { draft, configuration });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "LOCAL_CONFIGURATION_REQUIRED", message: expect.stringContaining("Upgrade LIFTY") } });
    expect(submit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { ...localConfiguration, contract_version: "unsupported" },
    { ...localConfiguration, context_version: "old" },
    { ...localConfiguration, workspace_ref: "foreign-workspace" },
    { ...localConfiguration, icp_config: { ...localConfiguration.icp_config, api_key: "private-candidate" } },
    { ...localConfiguration, icp_config: { ...localConfiguration.icp_config, organization_num_employees_ranges: ["big"] } },
    { ...localConfiguration, scout_overlay: "private-candidate" },
  ])("rejects invalid local candidates without echoing or enqueuing", async (configuration) => {
    const submit = vi.fn();
    const enqueue = vi.fn();
    const log = vi.fn();
    const response = await push(createApp({ authenticate, submitOnboarding: submit, enqueueOnboardingImport: enqueue, log }), { draft, configuration });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "LOCAL_CONFIGURATION_INVALID" } });
    expect(body).not.toContain("private-candidate");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-candidate");
    expect(submit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("requires authentication to read local generation context", async () => {
    const getContext = vi.fn();
    const response = await createApp({ getOnboardingContext: getContext }).request("/v1/onboarding/context");
    expect(response.status).toBe(401);
    expect(getContext).not.toHaveBeenCalled();
  });

  it("reads no-store context using only the authenticated session", async () => {
    const getContext = vi.fn(async () => onboardingContext);
    const response = await createApp({ authenticate, getOnboardingContext: getContext }).request("/v1/onboarding/context?workspace_ref=foreign-workspace");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ...onboardingContext, generation_rules: expect.stringContaining("52,000"), configuration_schema: expect.objectContaining({ type: "object" }) });
    expect(getContext).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("rejects copied global instructions before receipt or enqueue", async () => {
    const submit = vi.fn();
    const enqueue = vi.fn();
    const log = vi.fn();
    const configuration = { ...localConfiguration, scout_overlay: `${localConfiguration.scout_overlay}\n${onboardingContext.scout_global_base}` };
    const response = await push(createApp({ authenticate, getOnboardingContext: async () => onboardingContext, submitOnboarding: submit, enqueueOnboardingImport: enqueue, log }), { draft, configuration });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "LOCAL_CONFIGURATION_INVALID", issues: [{ code: "global_base_copied", path: "/configuration/scout_overlay", suggestion: expect.any(String) }] } });
    expect(submit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(configuration.scout_overlay);
  });

  it("publishes local configuration and context in the API contract", async () => {
    const document = await (await createApp().request("/openapi.json")).json();
    const schema = document.paths["/v1/onboarding"].post.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(["draft", "configuration"]);
    expect(schema.properties.configuration.required).toEqual(["contract_version", "context_version", "icp_config", "scout_overlay"]);
    expect(document.paths["/v1/onboarding/context"].get).toMatchObject({ operationId: "getOnboardingContext", security: [{ bearerAuth: [] }] });
  });

  it("gets context with no caller-controlled RPC arguments", async () => {
    const rpc = vi.fn(async () => ({ data: [onboardingContext], error: null }));
    expect(await getOnboardingContext({ ...session, client: { rpc } })).toEqual(onboardingContext);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_lifty_onboarding_context");
  });

  it("rejects unexpected context fields without exposing RPC content", async () => {
    const rpc = vi.fn(async () => ({ data: { ...onboardingContext, api_key: "private-context" }, error: null }));
    await expect(getOnboardingContext({ ...session, client: { rpc } })).rejects.toMatchObject({ code: "SUPABASE_INVALID_RESPONSE" });
  });

  it.each([
    ["PT400", "lifty_configuration_required", 422, "LOCAL_CONFIGURATION_REQUIRED"],
    ["PT400", "lifty_configuration_invalid: private-candidate", 422, "LOCAL_CONFIGURATION_INVALID"],
    ["PT409", "lifty_onboarding_context_stale", 409, "ONBOARDING_CONTEXT_STALE"],
    ["PT409", "lifty_configuration_mismatch", 409, "LOCAL_CONFIGURATION_MISMATCH"],
    ["PT409", "lifty_prompt_hand_tuned", 409, "PROMPT_HAND_TUNED"],
  ])("maps %s / %s without logging candidate content", async (code, message, status, publicCode) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code, message, details: "private-candidate" } }));
    const enqueue = vi.fn();
    const log = vi.fn();
    const app = createApp({
      authenticate: async () => ({ ok: true, session: { ...session, client: { rpc } } }),
      getOnboardingContext: async () => onboardingContext,
      submitOnboarding,
      enqueueOnboardingImport: enqueue,
      log,
    });
    const response = await push(app, { draft, configuration: localConfiguration });
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: publicCode } });
    if (publicCode === "ONBOARDING_CONTEXT_STALE") expect(JSON.parse(body).error.issues).toEqual([expect.objectContaining({ path: "/configuration/context_version" })]);
    expect(body).not.toContain("private-candidate");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-candidate");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
