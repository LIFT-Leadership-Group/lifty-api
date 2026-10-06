import type { AppDependencies, AuthSession } from "./app.js";
import { getAgentContext } from "./agent-context.js";
import {
  BusinessGetSchema,
  TargetingGetSchema,
  CriteriaGetSchema,
  SetupDraftGetSchema,
  SetupStatusSchema,
  type SetupGatesSchema,
} from "./business-contracts.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import {
  RunStatusSchema,
  CrmSyncStatusSchema,
  HubspotConnectionStatusSchema,
} from "./contracts.js";
import { readComponent } from "./workspace-summary.js";
import { CampaignsSchema } from "./outreach-contracts.js";
import { PublicError } from "./errors.js";
import { z } from "zod";
import { stageOperations } from "./stage-contracts.js";
import { operationToolNames } from "./operation-names.js";
import type { RunErrorCodeSchema } from "./contracts.js";
// Tool ids are derived from the operation catalog used by HTTP and MCP; a
// retired operation fails here instead of being recommended.
const tool = (resource: string, operation: string) => {
  if (!stageOperations[resource]?.[operation]) throw new Error(`Unknown catalog operation ${resource}.${operation}`);
  return operationToolNames(resource, operation)[0]!;
};
// Customer reasons for a failed sample and the one next move for each.
const sampleFailures: Record<z.infer<typeof RunErrorCodeSchema>, { action: string; tools: string[] }> = {
  research_limit_reached: {
    action: `This week's research limit was reached. Read ${tool("research-schedule", "status")} and give the founder its resets_at; start the sample again with ${tool("sample-review", "post")} after that time. Volume does not carry over and the limit is not raised by retrying.`,
    tools: [tool("research-schedule", "status"), tool("sample-review", "post")],
  },
  search_exhausted: {
    action: `The search ran out of new matching people. Propose one specific wider targeting change; after the founder agrees, save it with ${tool("targeting", "patch")} and its expected_version, then start a new sample with ${tool("sample-review", "post")}.`,
    tools: [tool("targeting", "get"), tool("targeting", "patch"), tool("sample-review", "post")],
  },
  research_failed: {
    action: `Research failed for a technical reason. Retry once with ${tool("sample-review", "post")}; it reuses the saved people and completed research. If it fails again, tell the founder LIFT is looking into it.`,
    tools: [tool("sample-review", "post")],
  },
  calibration_sample_incomplete: {
    action: `Some people lack current research, a valid profile URL or a fit rationale. Explain the gap, then retry once with ${tool("sample-review", "post")}; it reuses the saved people.`,
    tools: [tool("sample-review", "post")],
  },
  calibration_review_required: {
    action: `This older sample stopped for a grade check that no longer applies. ${tool("sample-review", "post")} reviews the same saved people under the current policy without new research.`,
    tools: [tool("sample-review", "post")],
  },
};
type Reads = Pick<
  AppDependencies,
  | "businessOperation"
  | "getRunStatus"
  | "outreachOperation"
  | "getHubspotConnection"
  | "getCrmSyncStatus"
>;
// The session forwards the caller's workspace selection; every read below
// resolves the same workspace through the shared database rule.
export async function getNextStep(
  deps: Reads,
  session: AuthSession,
): Promise<NextStep> {
  const read = (key: string) => deps.businessOperation(session, key);
  const business = BusinessGetSchema.parse(await read("business.get"));
  const ref = business.workspace?.workspace_ref ?? null;
  let saved: Record<string, unknown> | null = null;
  const response = (
    state: NextStep["state"],
    step: NextStep["step"],
    reason: string,
    actions: string[],
    tools: string[],
    context = "business",
    receipt: Record<string, unknown> | null = null,
    gates: z.infer<typeof SetupGatesSchema> | null = null,
    section: NextStep["section"] = "leads",
  ) => {
    const guide = getAgentContext(
      context === "sample-review"
        ? state === "review"
          ? "step-review"
          : "step-sample"
        : context,
    );
    if (!guide) throw new Error("Missing next-step guide");
    return NextStepSchema.parse({
      state,
      step,
      reason,
      section,
      actions,
      gates,
      workspace_ref: ref,
      recommended_tools: tools,
      guide,
      context_task: context,
      saved,
      receipt,
    });
  };
  if (!business.workspace || !business.profile)
    return response(
      "action_required",
      "business",
      "workspace_missing",
      [
        "Research the supplied website once and present one concise business hypothesis. Ask the founder to confirm or correct it, then create the workspace with business_post. Login alone creates nothing.",
      ],
      [tool("business", "post"), tool("business", "get")],
    );
  if (business.workspace.workspace_ref !== ref)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "The resource does not belong to the selected workspace.",
    });
  if (business.workspace.state === "suspended")
    return response(
      "blocked",
      "business",
      "workspace_suspended",
      ["Explain that the workspace is suspended and stop changes."],
      [tool("business", "get")],
    );
  if (!business.profile.confirmation.complete)
    return response(
      "action_required",
      "business",
      "business_confirmation_needed",
      [
        `Confirm or correct the missing commercial profile values: ${business.profile.confirmation.missing.join(", ")}. Save confirmed values with business_patch and its expected_version. Do not ask again for already confirmed values.`,
      ],
      [tool("business", "get"), tool("business", "patch")],
    );
  const [targeting, criteria, status] = await Promise.all([
    read("targeting.get").then((value) => TargetingGetSchema.parse(value)),
    read("research-criteria.get").then((value) =>
      CriteriaGetSchema.parse(value),
    ),
    read("setup.status").then((value) => SetupStatusSchema.parse(value)),
  ]);
  for (const value of [targeting, criteria, status])
    if (value.workspace_ref !== ref)
      throw new PublicError({
        status: 403,
        code: "WORKSPACE_FORBIDDEN",
        message: "The resource does not belong to the selected workspace.",
      });
  if (!targeting.targeting || !criteria.criteria || !criteria.criteria.text) {
    if (status.state === "imported")
      return response(
        "blocked",
        "import",
        "setup_resource_unavailable",
        [
          "The saved setup receipt exists but a required resource is unavailable. Retry setup_status and resource reads; do not submit another setup.",
        ],
        [
          tool("setup", "status"),
          tool("targeting", "get"),
          tool("research-criteria", "get"),
        ],
        "setup",
        status,
      );
    const draft = SetupDraftGetSchema.parse(await read("setup.get_draft"));
    if (draft.workspace_ref !== ref)
      throw new PublicError({
        status: 403,
        code: "WORKSPACE_FORBIDDEN",
        message: "The draft does not belong to the selected workspace.",
      });
    saved = draft;
    if (!draft.draft || draft.gates.missing.length || draft.gates.issues.length)
      return response(
        "action_required",
        "interview",
        "confirmed_interview_needed",
        [
          "Resume the workspace server draft. Ask only its next missing gate, leading with a hypothesis; save every confirmed block with setup_patch_draft and the returned expected_version. Exclusions need at least one evidence-based disqualifier or an excluded industry code filter; an empty parked-motions list is a valid decision.",
          "When gates are complete, call next_step.",
        ],
        [tool("setup", "get_draft"), tool("setup", "patch_draft")],
        "setup",
        null,
        draft.gates,
      );
    if (!draft.generated_criteria)
      return response(
        "action_required",
        "configuration",
        "configuration_needed",
        [
          "Read setup_generation_context, generate only Scout criteria from the saved draft and current base, then save them with setup_patch_draft. Bind source_versions to the profile, resulting draft version and base version.",
        ],
        [tool("setup", "generation_context"), tool("setup", "patch_draft")],
        "setup",
      );
    return response(
      "action_required",
      "submission",
      "configuration_saved",
      [
        `Submit once with setup_post {expected_draft_version:${draft.version}}. After a lost response use setup_status; a saved receipt proves both resources were created. This does not activate research or outreach.`,
      ],
      [tool("setup", "post"), tool("setup", "status")],
      "setup",
    );
  }
  // Resource heads are authoritative even when configured outside setup.
  const run = RunStatusSchema.parse(
    await deps.getRunStatus(session),
  );
  if (run.state !== "none" && run.workspace.workspace_ref !== ref)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "The research run does not belong to the selected workspace.",
    });
  if (run.state === "none")
    return response(
      "action_required",
      "sample-review",
      "sample_not_started",
      [
        `${tool("sample-review", "post")} with body {} and keep its run_ref. The sample uses five people of this week's research volume; with fewer than five left it returns RESEARCH_LIMIT_REACHED and resets_at: give the founder that reset time.`,
        "Tell the founder you are finding and researching five matching people, that it takes a few minutes, and that you will share each one as it lands.",
        `${tool("sample-review", "progress")} with run_ref, then the returned cursor and wait_seconds 25 until terminal. Keep one request open and narrate each new lead in one line.`,
        "When terminal, call next_step. This bounded initial sample does not activate weekly research or outreach.",
      ],
      [tool("sample-review", "post"), tool("sample-review", "progress")],
      "sample-review",
    );
  if (["queued", "running"].includes(run.state))
    return response(
      "pending",
      "sample-review",
      "sample_pending",
      [
        `${tool("sample-review", "progress")} with run_ref ${run.run_ref}, then the returned cursor and wait_seconds 25 until terminal. Narrate each newly researched lead in one line.`,
        "One request at a time: no sleeps and never POST again to check progress.",
        "When terminal, call next_step.",
      ],
      [tool("sample-review", "progress")],
      "sample-review",
      run,
    );
  if (run.state === "failed") {
    const failure = sampleFailures[run.error_code ?? "research_failed"];
    return response(
      "blocked",
      "sample-review",
      "sample_failed",
      [
        `The sample stopped with reason ${run.error_code ?? "research_failed"}. Read ${tool("sample-review", "get")} for the saved people and explain the reason plainly.`,
        failure.action,
        "Saved leads stay usable; outreach setup does not have to wait for the sample.",
      ],
      [tool("sample-review", "get"), ...failure.tools],
      "sample-review",
      run,
    );
  }
  const campaigns = CampaignsSchema.parse(await deps.outreachOperation(session, "campaigns.get", { path: {}, query: {}, body: undefined }));
  if (campaigns.workspace.workspace_ref !== ref)
    throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Outreach state changed workspace." });
  if (!campaigns.campaigns.length) {
    const crm = await readComponent(async () =>
      HubspotConnectionStatusSchema.parse(
        await deps.getHubspotConnection(session),
      ),
    );
    let crmAction =
      "Read crm_get before offering CRM sync; its saved connection is currently unavailable. A leads-only workspace can remain here.";
    if (crm.status === "available") {
      if (crm.value.status !== "connected")
        crmAction =
          "Ask once whether the founder wants these leads and their research in their CRM. Connect only after a separate explicit request; a leads-only workspace can remain here.";
      else if (crm.value.reconnect_required)
        crmAction =
          "The saved CRM connection needs reconnecting. Reconnect only after a separate explicit request; a leads-only workspace can remain here.";
      else {
        const sync = await readComponent(async () => {
          const value = CrmSyncStatusSchema.parse(
            await deps.getCrmSyncStatus(session),
          );
          if (value.state !== "none" && value.workspace.workspace_ref !== ref)
            throw new PublicError({
              status: 403,
              code: "WORKSPACE_FORBIDDEN",
              message:
                "The CRM sync does not belong to the selected workspace.",
            });
          return value;
        });
        if (sync.status === "unavailable")
          crmAction =
            "The CRM connection is saved; read crm_sync_status before offering a sync because its previous receipt is unavailable.";
        else if (sync.value.state === "none")
          crmAction =
            "The CRM connection is saved and nothing is synced yet. Offer to sync these leads only after a separate explicit request: crm_mapping_context (company setup with crm_patch if not ready), crm_preferences_get and the founder's research-note and conversation choices (crm_preferences_patch only for what they change), crm_sync_start, then crm_sync_status.";
        else if (["queued", "running"].includes(sync.value.state))
          crmAction = `The CRM sync is in progress (run_ref ${sync.value.run_ref}). Read crm_sync_status; do not start another sync.`;
        else if (sync.value.state === "succeeded")
          crmAction = `The CRM sync finished (${sync.value.leads_synced ?? 0} leads). Do not repeat it just to check status.`;
        else
          crmAction = `The CRM sync failed (${sync.value.error_code ?? "unknown"}). Read crm_sync_status and resolve its blocker before offering a retry.`;
      }
    }
    return response(
      "review",
      "sample-review",
      "sample_ready_for_founder_review",
      [
        "Show the researched leads from receipt.leads (sample_review_get only if you need more): your read first, then person, company, grade, LinkedIn URL, fit rationale and evidence gaps. Include lower-fit profiles and explain their mismatch.",
        "Ask one question: does this confirm the targeting, or what should change? A change follows summary_context task targeting or research-criteria, its synchronous PATCH/readback, then a new sample.",
        crmAction,
        "Close Section 1 in at most six lines: target, leads and grade mix, and CRM result. Then ask whether to set up LinkedIn outreach now; yes: summary_context task campaigns. A leads-only founder can stop here. If not now, accept it and do not ask again this session.",
      ],
      [
        tool("sample-review", "get"),
        tool("crm", "get"),
        tool("crm", "post"),
        tool("crm", "mapping_context"),
        tool("crm", "patch"),
        tool("crm", "sync_start"),
        tool("crm", "sync_status"),
        tool("summary", "context"),
      ],
      "sample-review",
      run,
    );
  }
  return response(
    "action_required", "campaign", "campaigns_saved",
    ["Read campaigns_get and journeys_get for the exact saved drafts, approvals, selected revisions, executable version and intent. Publish only the chosen exact revision; activate separately with explicit founder authorization. Paused intent and account/readiness/incident holds remain independent."],
    [tool("campaigns", "get"), tool("journeys", "get"), tool("summary", "context")], "campaigns",
    { campaigns: campaigns.campaigns.map(value => ({ campaign_ref: value.campaign_ref, journey_ref: value.journey_ref, version: value.version, state: value.state, channel: value.channel })) }, null, "outreach",
  );
}
