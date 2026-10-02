import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import { validateIdentityInput, type IdentityDefinition, type IdentityInput } from "./identity-operations.js";
import * as c from "./outreach-contracts.js";

const Empty = z.object({}).strict();
export type OutreachInput = IdentityInput;
type Definition = IdentityDefinition;
const invalid = { status: 422, code: "OUTREACH_INVALID" } as const;
const unavailable = { code: "OUTREACH_UNAVAILABLE", message: "Outreach state could not be verified. Read the resource before retrying a change." };
function definition(resource: "journeys" | "campaigns", action: string, method: Definition["method"],
  request: z.ZodType | null, response: z.ZodType, description: string): Definition {
  const journey = resource === "journeys";
  const plural = resource;
  const singular = journey ? "journey" : "campaign";
  const detail = !["get", "post"].includes(action);
  const suffix = action === "detail" ? "" : action === "draft_patch" ? "/draft" : `/${action}`;
  const rpc = action === "get" ? `get_lifty_${plural}` : action === "detail" ? `get_lifty_${singular}`
    : action === "post" ? `create_lifty_${singular}` : action === "draft_patch" ? `patch_lifty_${singular}_draft`
      : `${action}_lifty_${singular}`;
  return { method, route: `/v1/workspace/${plural}${detail ? `/{${singular}_ref}${suffix}` : ""}`,
    rpc, path: detail ? journey ? c.JourneyPathSchema : c.CampaignPathSchema : Empty,
    query: action === "get" ? journey ? c.PageQuerySchema : c.CampaignQuerySchema : Empty,
    request, response, invalid, success: action === "post" ? 201 : 200,
    cli: { operation: action === "draft_patch" ? "draft" : action },
    args: input => ({ ...(detail ? { [`p_${singular}_id`]: input.path[`${singular}_ref`] } : {}),
      ...(action === "get" ? { p_query: input.query } : method === "GET" ? {} : { p_payload: input.body }) }),
    description,
  };
}
function testDefinition(action: "tests_get" | "tests_post" | "test_detail"): Definition {
  const read = action !== "tests_post";
  const detail = action === "test_detail";
  return { method: read ? "GET" : "POST", route: `/v1/workspace/campaigns/{campaign_ref}/tests${detail ? "/{test_ref}" : ""}`,
    rpc: detail ? "get_lifty_campaign_test" : read ? "get_lifty_campaign_tests" : "create_lifty_campaign_test",
    path: detail ? c.CampaignTestPathSchema : c.CampaignPathSchema, query: action === "tests_get" ? c.PageQuerySchema : Empty,
    request: read ? null : c.CampaignTestCreateSchema, response: action === "tests_get" ? c.CampaignTestsSchema : c.CampaignTestResultSchema,
    invalid, success: read ? 200 : 202, cli: { operation: action },
    args: input => ({ p_campaign_id: input.path.campaign_ref, ...(detail ? { p_test_id: input.path.test_ref } : {}),
      ...(action === "tests_get" ? { p_query: input.query } : read ? {} : { p_payload: input.body }) }),
    description: action === "tests_post" ? "Queue an isolated saved candidate test with exact revision/digest/CAS and idempotent request_ref. Sample at most 20 explicit leads or reuse a completed baseline's exact leads and saved before outputs. Compose after only; disclose changed context. Preview person is provenance, never lead assignment. Does not enroll, approve, activate or send."
      : detail ? "Read saved signed test outputs and exact provenance. Pending is authoritative; baseline outputs are never regenerated."
        : "Discover durable saved test receipts after a lost response or in a fresh session. Paginated summaries contain no output bodies.",
  };
}
function messageDefinition(revise: boolean): Definition {
  return { method: revise ? "POST" : "GET", route: `/v1/workspace/campaign-messages/{message_ref}${revise ? "/revisions" : ""}`,
    rpc: revise ? "revise_lifty_campaign_message" : "get_lifty_campaign_message", path: c.CampaignMessagePathSchema, query: Empty,
    request: revise ? c.CampaignMessageReviseSchema : null, response: c.CampaignMessageResultSchema, invalid, success: revise ? 201 : 200,
    cli: { operation: revise ? "message_revisions_post" : "message_get" }, args: input => ({ p_message_id: input.path.message_ref,
      ...(revise ? { p_payload: input.body } : {}) }),
    description: revise ? "Correct an actual still-unapproved per-lead saved draft into a new pending revision using exact source_digest/review state and idempotent request_ref. Preserve old bytes, person/signature, source and template/prompt/library provenance. Existing reviewer approval path applies; never approves or sends. Approved/sent/superseded messages and missing signature pins are rejected."
      : "Read an actual saved per-lead message in the selected workspace. No canonical campaign membership is inferred for historical drafts. Does not generate, approve, activate or send.",
  };
}
export const outreachOperationDefinitions = {
  journeys: {
    get: definition("journeys", "get", "GET", null, c.JourneysSchema, "Read saved journeys in the selected workspace. Unknown reads are unavailable, not an empty audience."),
    detail: definition("journeys", "detail", "GET", null, c.JourneyResultSchema, "Read one journey's draft, approvals and exact active binding. Does not generate or change work."),
    post: definition("journeys", "post", "POST", c.JourneyCreateSchema, c.JourneyResultSchema, "Save a persistent audience and journey draft. Qualified audience consumes Searches facts; an explicit static list is a customer choice, never a calibration sample. Does not approve or activate."),
    draft_patch: definition("journeys", "draft_patch", "PATCH", c.JourneyDraftSchema, c.JourneyResultSchema, "Append a journey draft with expected_version and its exact source revision. Audience and graph changes apply only to future entrants after separate publication and activation. Existing runs keep their binding."),
    publish: definition("journeys", "publish", "POST", c.PublishSchema, c.JourneyResultSchema, "Approve the chosen exact journey revision and digest. Records actor/time only; does not activate, admit leads or authorize channel sending."),
    activate: definition("journeys", "activate", "POST", c.JourneyActivateSchema, c.JourneyResultSchema, "Activate an exact approved journey with exact approved campaign revisions for future entrants. Paused/unready campaigns may be pinned but gain no sending intent. Existing runs retain their binding; missing branches remain pending."),
  },
  campaigns: {
    runtime: { ...definition("campaigns", "runtime", "GET", null, c.CampaignRuntimeSchema,
      "Read derived native admissions and continuing/pending/prepared runs grouped by exact binding/revision, plus recorded gate reasons only. Intent is separate from execution/readiness. No recorded reason does not prove ready; failed reads remain unavailable."), rpc: "get_lifty_campaign_runtime" },
    message_get: messageDefinition(false),
    message_revisions_post: messageDefinition(true),
    tests_get: testDefinition("tests_get"),
    tests_post: testDefinition("tests_post"),
    test_detail: testDefinition("test_detail"),
    get: definition("campaigns", "get", "GET", null, c.CampaignsSchema, "Read channel campaigns, optionally by journey_ref/channel. Uses the selected workspace; no singleton workspace configuration or provider selector."),
    detail: definition("campaigns", "detail", "GET", null, c.CampaignResultSchema, "Read one campaign's intent, immutable draft/approval history and effective revision derived from its journey binding. Account readiness is independent and is not inferred from this resource."),
    post: definition("campaigns", "post", "POST", c.CampaignCreateSchema, c.CampaignResultSchema, "Save an inactive unapproved channel campaign draft. Refer to canonical sender_ids; several named senders may be permitted but each lead retains one immutable person. Graph attachment is a separate journey draft edit. Never sends."),
    draft_patch: definition("campaigns", "draft_patch", "PATCH", c.CampaignDraftSchema, c.CampaignResultSchema, "Change supplied sequence/templates/instructions/delays into an unapproved immutable draft using expected_version and source revision_ref. Active approved work continues; pause/readiness/incident holds and started pins remain unchanged."),
    publish: definition("campaigns", "publish", "POST", c.PublishSchema, c.CampaignResultSchema, "Publish as exact approval of one revision/digest. Records actor/time; binding and intent stay unchanged. It never activates, resumes or sends."),
    activate: definition("campaigns", "activate", "POST", c.CampaignActivateSchema, c.CampaignActivationResultSchema, "Activate the chosen exact approved campaign revision with campaign and journey CAS. Requires an active journey binding; replaces only this future-start pin and its intent. Same action after pause, no resume alias. Started runs and sibling pins remain unchanged; account/readiness/incident gates still apply."),
    pause: definition("campaigns", "pause", "POST", c.CampaignPauseSchema, c.CampaignResultSchema, "Pause all automatic campaign steps, including follow-ups, with expected_version. Pending work/history remains and begun/unknown effects reconcile. Other graph-permitted channels continue. Does not claim provider stop confirmation."),
  },
};
export const outreachEntries = () => Object.entries(outreachOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, resource, action, definition })));
export const validateOutreachInput = validateIdentityInput;

export async function executeOutreachOperation(session: AuthSession, key: string, input: OutreachInput): Promise<unknown> {
  const entry = outreachEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown Outreach operation");
  const { definition } = entry;
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
    .rpc(definition.rpc, { p_workspace_id: null, ...definition.args(input) }); }
  catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
  if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
  const parsed = definition.response.safeParse(result.data);
  if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
  // A response for another resource cannot confirm this operation's outcome.
  const value = parsed.data as { journey?: { journey_ref: string }; campaign?: { campaign_ref: string } };
  if (entry.action === "runtime") {
    if (c.CampaignRuntimeSchema.parse(parsed.data).campaign_ref !== input.path.campaign_ref)
      throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  }
  if (entry.action === "message_get" || entry.action === "message_revisions_post") {
    const message = c.CampaignMessageResultSchema.parse(parsed.data).message;
    if (entry.action === "message_get" ? message.message_ref !== input.path.message_ref
      : message.message_ref === input.path.message_ref || message.source_message_ref !== input.path.message_ref
        || !message.sender_id || !message.sender_version)
      throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  }
  if (entry.action.startsWith("tests_") || entry.action === "test_detail") {
    const receipt = parsed.data as { test?: { campaign_ref: string; test_ref: string }; tests?: Array<{ campaign_ref: string }> };
    if (receipt.test ? receipt.test.campaign_ref !== input.path.campaign_ref || (input.path.test_ref && receipt.test.test_ref !== input.path.test_ref)
      : receipt.tests?.some(test => test.campaign_ref !== input.path.campaign_ref)) throw new PublicError({ status: 502, ...unavailable });
    if (entry.action === "tests_post") {
      const saved = c.CampaignTestResultSchema.parse(parsed.data).test;
      const requested = input.body as z.infer<typeof c.CampaignTestCreateSchema>;
      if (saved.request_ref !== requested.request_ref || saved.revision_ref !== requested.revision_ref || saved.digest !== requested.digest
        || ("baseline_test_ref" in requested.sample ? saved.baseline_test_ref !== requested.sample.baseline_test_ref
          : saved.baseline_test_ref !== null || saved.samples.length !== requested.sample.lead_refs.length
            || saved.samples.some(sample => !("lead_refs" in requested.sample) || !requested.sample.lead_refs.includes(sample.lead_ref))))
        throw new PublicError({ status: 502, ...unavailable });
    }
    return parsed.data;
  }
  if ((input.path.journey_ref && value.journey?.journey_ref !== input.path.journey_ref)
    || (input.path.campaign_ref && value.campaign?.campaign_ref !== input.path.campaign_ref))
    throw new PublicError({ status: 502, ...unavailable });
  const body = input.body as { revision_ref?: string; digest?: string } | undefined;
  if (entry.action === "publish") {
    const resource = entry.resource === "journeys" ? c.JourneyResultSchema.parse(parsed.data).journey : c.CampaignResultSchema.parse(parsed.data).campaign;
    if (!resource.revisions.some(revision => revision.revision_ref === body?.revision_ref && revision.digest === body?.digest && revision.approval))
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (key === "journeys.activate") {
    const binding = c.JourneyResultSchema.parse(parsed.data).journey.active_binding;
    const requested = input.body as z.infer<typeof c.JourneyActivateSchema>;
    if (!binding || binding.journey.revision_ref !== requested.revision_ref || binding.journey.digest !== requested.digest
      || binding.campaigns.length !== requested.campaigns.length || requested.campaigns.some(pin => !binding.campaigns.some(selected =>
        selected.campaign_ref === pin.campaign_ref && selected.revision.revision_ref === pin.revision_ref && selected.revision.digest === pin.digest)))
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (key === "campaigns.activate") {
    const receipt = c.CampaignActivationResultSchema.parse(parsed.data);
    const revision = receipt.campaign.effective_revision;
    const selected = receipt.journey.active_binding?.campaigns.find(pin => pin.campaign_ref === input.path.campaign_ref);
    if (receipt.campaign.state !== "active" || !revision?.approval || revision.revision_ref !== body?.revision_ref || revision.digest !== body?.digest
      || selected?.revision.revision_ref !== revision.revision_ref || selected.revision.digest !== revision.digest
      || receipt.journey.journey_ref !== receipt.campaign.journey_ref)
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (key === "campaigns.pause" && c.CampaignResultSchema.parse(parsed.data).campaign.state !== "paused")
    throw new PublicError({ status: 502, ...unavailable });
  return parsed.data;
}
