import type { AppDependencies, AuthSession } from "./app.js";
import { getAgentContext } from "./agent-context.js";
import { WorkspaceStatusSchema, OnboardingStatusSchema, RunStatusSchema } from "./contracts.js";
import { OnboardingStateSchema } from "./onboarding-state.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import { WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { PublicError } from "./errors.js";

// Only the persisted-state readers belong here. Provider connection "status"
// operations can bind accounts, record health and remove provider duplicates.
// Campaign "status" is a stable database read (no preparation or activation).
type NextStepReads = Pick<AppDependencies, "getWorkspace" | "getOnboardingState" | "getOnboardingStatus" | "getRunStatus" | "workspaceCampaign">;
export async function getNextStep(dependencies: NextStepReads, session: AuthSession): Promise<NextStep> {
  const workspace = WorkspaceStatusSchema.parse(await dependencies.getWorkspace(session));
  const workspaceRef = workspace.workspace?.workspace_ref ?? null;
  const response = (state: NextStep["state"], step: NextStep["step"], reason: string, task: string,
    tools: string[], saved: Record<string, unknown> | null, receipt: Record<string, unknown> | null = null) => {
    const guide = getAgentContext(task);
    if (!guide) throw new Error("Missing next-step context");
    return NextStepSchema.parse({ state, step, reason, workspace_ref: workspaceRef, recommended_tools: tools, guide, saved, receipt });
  };
  if (workspace.state === "suspended") return response("blocked", "business", "workspace_suspended", "business", ["business_get"], null);
  const saved = OnboardingStateSchema.parse(await dependencies.getOnboardingState(session));
  const requireWorkspace = (ref: string | null) => {
    if (ref !== null && ref !== workspaceRef) throw new PublicError({ status: 502, code: "ONBOARDING_STATE_UNAVAILABLE", message: "The current workspace and saved onboarding do not match. Retry the read before making changes." });
  };
  if (saved.state === "saved") requireWorkspace(saved.workspace_ref);
  if (workspace.state === "needs_workspace") return response("action_required", "business", "workspace_missing", "business", ["business_get", "business_post"], saved);

  // Imports remain authoritative even for legacy CLI sessions with no draft cache.
  const onboarding = OnboardingStatusSchema.parse(await dependencies.getOnboardingStatus(session));
  if (onboarding.state !== "none") requireWorkspace(onboarding.workspace.workspace_ref);
  if (onboarding.state === "pending") return response("pending", "import", "import_pending", "targeting", ["targeting_onboarding_status"], saved, onboarding);
  if (onboarding.state === "failed") return response("blocked", "import", "import_failed", "targeting", ["targeting_onboarding_status", "targeting_onboarding_state"], saved, onboarding);
  if (onboarding.state === "imported") {
    const run = RunStatusSchema.parse(await dependencies.getRunStatus(session));
    if (run.state !== "none") requireWorkspace(run.workspace.workspace_ref);
    if (run.state === "none") return response("action_required", "sample-review", "sample_not_started", "sample-review", ["capacity_get", "sample_review_post"], saved, onboarding);
    if (run.state === "queued" || run.state === "running") return response("pending", "sample-review", "sample_pending", "sample-review", ["sample_review_progress"], saved, run);
    if (run.state === "failed") return response("blocked", "sample-review", "sample_failed", "sample-review", ["sample_review_get"], saved, run);
    // Sample acceptance is not persisted. A saved campaign is the evidence that
    // the founder moved past the sample; without one the sample is the resting
    // point, which is also where a lead-only founder stays.
    if (workspaceRef === null) throw new Error("Missing workspace reference");
    const campaign = WorkspaceCampaignResult.parse(await dependencies.workspaceCampaign(session, { operation: "status", payload: { workspace: workspaceRef } }));
    requireWorkspace(campaign.workspace_ref);
    if (campaign.state === "unconfigured") return response("review", "sample-review", "sample_ready_for_founder_review", "sample-review", ["sample_review_get"], saved, run);
    const receipt = { state: campaign.state, outreach_enabled: campaign.outreach_enabled, version_ref: campaign.version_ref,
      preparation: campaign.preparation?.state ?? null, blockers: campaign.blockers };
    // The campaigns guide with its references is ~300 KB; inlining it on every
    // resume stalls chat connectors. Return the workspace resume guide and let
    // the client fetch the campaigns guide when the founder works on it.
    const tools = ["campaigns_get", "summary_context"];
    if (campaign.state === "active") return response("complete", "campaign", "campaign_active", "summary", tools, saved, receipt);
    if (campaign.state === "paused") return response("action_required", "campaign", "campaign_paused", "summary", tools, saved, receipt);
    if (campaign.preparation?.state === "pending") return response("pending", "campaign", "campaign_preparing", "summary", tools, saved, receipt);
    if (campaign.preparation?.state === "failed") return response("blocked", "campaign", "campaign_preparation_failed", "summary", tools, saved, receipt);
    return response("action_required", "campaign", "campaign_draft", "summary", tools, saved, receipt);
  }
  if (saved.state === "none" || !saved.draft_ready) return response("action_required", "interview", "confirmed_interview_needed", "onboarding", ["business_onboarding_state", "business_onboarding_save"], saved);
  if (!saved.configuration) return response("action_required", "configuration", "configuration_needed", "targeting", ["targeting_onboarding_context", "targeting_onboarding_save"], saved);
  return response("action_required", "submission", "configuration_saved", "targeting", ["targeting_post", "targeting_onboarding_status"], saved);
}
