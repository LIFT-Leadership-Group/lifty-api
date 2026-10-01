import { selectWorkspace } from "./workspace-selection.js";
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
import { resolveBusinessWorkspace } from "./business-workspace.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import {
  RunStatusSchema,
  CrmSyncStatusSchema,
  HubspotConnectionStatusSchema,
} from "./contracts.js";
import { readComponent } from "./workspace-summary.js";
import { WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { PublicError } from "./errors.js";
import { z } from "zod";
import { businessOperationDefinitions } from "./business-operations.js";
// Tool ids follow the same operation catalog used by HTTP and MCP.
const tool = (
  resource: keyof typeof businessOperationDefinitions,
  operation: string,
) => `${resource.replace(/-/g, "_")}_${operation}`;
type Reads = Pick<
  AppDependencies,
  | "businessOperation"
  | "listMemberWorkspaces"
  | "getRunStatus"
  | "workspaceCampaign"
  | "getHubspotConnection"
  | "getCrmSyncStatus"
>;
export async function getNextStep(
  deps: Reads,
  session: AuthSession,
  selection?: string,
): Promise<NextStep> {
  const target = await resolveBusinessWorkspace(deps, session, selection);
  const ref = target?.workspace_ref ?? null;
  const read = (key: string) => deps.businessOperation(session, key, ref);
  const business = BusinessGetSchema.parse(await read("business.get"));
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
    const guide = getAgentContext(context);
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
  if (business.workspace.state === "retired")
    return response(
      "blocked",
      "business",
      "workspace_retired",
      [
        "This workspace is retired. Retained records remain readable; new work cannot start.",
      ],
      [tool("business", "get")],
    );
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
          "Resume the workspace server draft. Ask only its next missing gate, leading with a hypothesis; save every confirmed block with setup_patch_draft and the returned expected_version. Empty disqualifiers or parked motions are valid explicit decisions.",
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
    await deps.getRunStatus(selectWorkspace(session, ref!)),
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
        "Business is configured. Offer the initial sample with sample_review_post only after the founder asks to start; then follow its exact run_ref with sample_review_progress. This never activates recurring research or outreach.",
      ],
      ["sample_review_post", "sample_review_progress"],
      "sample-review",
    );
  if (["queued", "running"].includes(run.state))
    return response(
      "pending",
      "sample-review",
      "sample_pending",
      [
        `Follow sample_review_progress for run_ref ${run.run_ref}, one bounded request at a time. Narrate new researched people; never POST to check progress.`,
      ],
      ["sample_review_progress"],
      "sample-review",
      run,
    );
  if (run.state === "failed")
    return response(
      "blocked",
      "sample-review",
      "sample_failed",
      [
        "Read the exact research failure and explain its blocker. Retain saved results and retry only when the failure and founder intent allow it.",
      ],
      ["sample_review_get"],
      "sample-review",
      run,
    );
  const campaign = WorkspaceCampaignResult.parse(
    await deps.workspaceCampaign(session, {
      operation: "status",
      payload: { workspace: ref! },
    }),
  );
  if (campaign.workspace_ref !== ref)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "The campaign does not belong to the selected workspace.",
    });
  if (campaign.state === "unconfigured") {
    const crm = await readComponent(async () =>
      HubspotConnectionStatusSchema.parse(
        await deps.getHubspotConnection(selectWorkspace(session, ref!)),
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
            await deps.getCrmSyncStatus(selectWorkspace(session, ref!)),
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
            "The CRM connection is saved and nothing is synced yet. Offer to sync these leads only after a separate explicit request.";
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
        "Show the researched people and evidence. Ask whether the targeting is confirmed or what should change. A leads-only workspace can stay here; CRM sync and outreach are optional and require a separate request.",
        crmAction,
      ],
      ["sample_review_get", "summary_context"],
      "sample-review",
      run,
    );
  }
  const state =
    campaign.state === "active"
      ? "complete"
      : campaign.preparation?.state === "pending"
        ? "pending"
        : campaign.preparation?.state === "failed"
          ? "blocked"
          : "action_required";
  return response(
    state,
    "campaign",
    campaign.preparation?.state === "pending"
      ? "campaign_preparing"
      : campaign.preparation?.state === "failed"
        ? "campaign_preparation_failed"
        : `campaign_${campaign.state}`,
    [
      "Read campaigns_get for the saved campaign and relevant blockers. Resume, prepare or activate only with explicit founder approval; Business changes never activate outreach.",
    ],
    ["campaigns_get", "summary_context"],
    "summary",
    {
      state: campaign.state,
      version_ref: campaign.version_ref,
      preparation: campaign.preparation?.state ?? null,
      blockers: campaign.blockers,
    },
    null,
    "outreach",
  );
}
