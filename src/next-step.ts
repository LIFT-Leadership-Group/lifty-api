import type { AppDependencies, AuthSession } from "./app.js";
import { getAgentContext } from "./agent-context.js";
import { WorkspaceStatusSchema, OnboardingStatusSchema, RunStatusSchema, HubspotConnectionStatusSchema,
  CrmSyncStatusSchema, type HubspotConnectionStatus, type CrmSyncStatus } from "./contracts.js";
import { OnboardingStateSchema, type OnboardingState } from "./onboarding-state.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import { interviewGates, type InterviewGate, type InterviewGates } from "./interview-gates.js";
import { WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { PublicError } from "./errors.js";

// Only the persisted-state readers belong here. Provider connection "status"
// operations can bind accounts, record health and remove provider duplicates.
// Campaign "status" is a stable database read (no preparation or activation).
// HubSpot connection and CRM sync are database reads that only shape the
// review step's CRM action; their failure never blocks the next step.
type NextStepReads = Pick<AppDependencies, "getWorkspace" | "getOnboardingState" | "getOnboardingStatus" | "getRunStatus" | "workspaceCampaign">
  & Partial<Pick<AppDependencies, "getHubspotConnection" | "getCrmSyncStatus">>;

interface Step {
  state: NextStep["state"]; step: NextStep["step"]; reason: string; section: NextStep["section"];
  actions: (string | null)[]; tools: string[];
  // Playbook returned inline, and the stage whose full guide summary_context serves.
  guide: string; context: string | null;
  gates?: InterviewGates | null; receipt?: Record<string, unknown> | null;
}

const ASK: Record<InterviewGate, string> = {
  company: "what the company sells and to whom (name and a plain description)",
  offer: "the value proposition, the buyer's top pain points (up to five) and the offerings, as your researched read to confirm or correct",
  motion: "the primary sales motion and the outcome it drives (park any other motion)",
  market: "target industries plus a numeric size range and its unit",
  exclusions: "at least one hard exclusion: who must never be targeted",
  boundaries: "search boundaries: company HQ countries, buyer location and headcount, each a limit or explicitly unrestricted",
  persona: "the first buyer: decision maker or influencer, first-contact titles and the organizational tell",
};
const SUBMIT_AND_FOLLOW = "Read targeting_onboarding_status every few seconds until imported or failed; never POST again to check. Then call next_step.";

function interviewStep(saved: OnboardingState, workspaceMissing: boolean): Step {
  const gates = interviewGates(saved.state === "saved" ? saved.draft : null);
  const revision = saved.revision;
  const create = workspaceMissing ? "After the founder confirms the company, create the workspace once with business_post {name, description, website_url}." : null;
  const save = `Save each confirmed block with business_onboarding_save (expected_revision ${revision} or the latest returned, configuration null); its gates.next is the next question. Do not call next_step between blocks.`;
  const finish = "When a save returns draft_ready true, play back the target in two to four lines and call next_step.";
  let actions: (string | null)[];
  if (saved.state === "none") {
    actions = [
      "Reply to the founder in one line now with what you will look into; then research their website and public profiles once.",
      "Play back your read in one message: what they sell and to whom, the value proposition, the buyer's top pain points, the offerings, the primary motion, industries and a numeric size range. Ask them to confirm or correct it.",
      create, save, "Ask the remaining gates one block at a time, leading with your hypothesis.", finish,
    ];
  } else if (gates.next) {
    const later = gates.missing.slice(1);
    actions = [
      "Resume from the saved draft: do not research again or repeat confirmed answers.", create,
      `Ask next: ${ASK[gates.next]}. Lead with your hypothesis and say why it changes the search.`,
      later.length ? `Still missing after that: ${later.join(", ")}.` : null, save, finish,
    ];
  } else if (saved.state === "saved" && !saved.draft_ready) {
    actions = [
      "Every interview decision is saved but the draft has technical problems: fix gates.issues yourself, without asking the founder.",
      `Save the corrected draft with business_onboarding_save (expected_revision ${revision}, configuration null) and check draft_ready.`,
      create, "When draft_ready is true, call next_step.",
    ];
  } else {
    actions = [create ?? "The interview is complete.", "Call next_step."];
  }
  return { state: "action_required", step: workspaceMissing ? "business" : "interview",
    reason: workspaceMissing ? "workspace_missing" : "confirmed_interview_needed", section: "leads", actions,
    tools: ["business_onboarding_state", "business_onboarding_save", ...(workspaceMissing ? ["business_get", "business_post"] : [])],
    guide: "step-interview", context: "onboarding", gates };
}

function crmAction(hubspot: HubspotConnectionStatus | null, sync: CrmSyncStatus | null): string {
  const flow = "crm_mapping_context (company setup with crm_patch if not ready), crm_sync_start, crm_sync_status";
  if (!hubspot) return "Read crm_get before offering HubSpot; if it stays unreadable, say the CRM status is unknown and continue.";
  if (hubspot.status === "not_connected") return `Ask once whether they want these leads and their research in HubSpot (optional). Yes: crm_post, show the link, crm_get with its attempt_ref, then ${flow}. No, or another CRM: continue.`;
  if (hubspot.reconnect_required) return "HubSpot needs reconnecting: offer a fresh crm_post link and verify it with crm_get before any sync.";
  if (!sync) return "HubSpot is connected: read crm_sync_status before offering a sync of these leads.";
  if (sync.state === "none") return `HubSpot is connected and nothing is synced yet: offer to sync these leads: ${flow}.`;
  if (sync.state === "queued" || sync.state === "running") return `A HubSpot sync is in progress (run_ref ${sync.run_ref}): read crm_sync_status until it finishes, then report contacts and companies delivered.`;
  if (sync.state === "succeeded") return `The last HubSpot sync finished (${sync.leads_synced ?? sync.requested_leads} leads): include it in the recap; crm_records returns record links if asked.`;
  return `The last HubSpot sync failed (${sync.error_code ?? "no reason recorded"}): explain it and offer one retry with crm_sync_start.`;
}

async function readCrm(dependencies: NextStepReads, session: AuthSession, workspaceRef: string) {
  const settle = async <T>(read: (() => Promise<unknown>) | undefined, parse: (value: unknown) => T) => {
    try { return read ? parse(await read()) : null; } catch { return null; }
  };
  const [hubspot, sync] = await Promise.all([
    settle(dependencies.getHubspotConnection && (() => dependencies.getHubspotConnection!(session)), value => HubspotConnectionStatusSchema.parse(value)),
    settle(dependencies.getCrmSyncStatus && (() => dependencies.getCrmSyncStatus!(session)), value => CrmSyncStatusSchema.parse(value)),
  ]);
  // A receipt for another workspace is not evidence about this one.
  return { hubspot, sync: sync && sync.state !== "none" && sync.workspace.workspace_ref !== workspaceRef ? null : sync };
}

// The saved draft stays useful for the recap; after import the generated
// configuration and submission receipt only cost context.
function savedView(saved: OnboardingState, imported: boolean): Record<string, unknown> | null {
  if (saved.state === "none") return null;
  const { gates: _gates, ...rest } = saved;
  if (!imported) return rest;
  return { state: rest.state, revision: rest.revision, workspace_ref: rest.workspace_ref, draft: rest.draft, updated_at: rest.updated_at };
}

export async function getNextStep(dependencies: NextStepReads, session: AuthSession): Promise<NextStep> {
  const workspace = WorkspaceStatusSchema.parse(await dependencies.getWorkspace(session));
  const workspaceRef = workspace.workspace?.workspace_ref ?? null;
  let savedForResponse: Record<string, unknown> | null = null;
  const response = (step: Step) => {
    const guide = getAgentContext(step.guide);
    if (!guide) throw new Error("Missing next-step context");
    return NextStepSchema.parse({ state: step.state, step: step.step, reason: step.reason, section: step.section,
      actions: step.actions.filter((action): action is string => action !== null), gates: step.gates ?? null,
      workspace_ref: workspaceRef, recommended_tools: step.tools, guide, context_task: step.context,
      saved: savedForResponse, receipt: step.receipt ?? null });
  };
  if (workspace.state === "suspended") return response({ state: "blocked", step: "business", reason: "workspace_suspended", section: "leads",
    actions: ["The workspace is suspended: explain the restriction and stop. Do not choose another workspace."],
    tools: ["business_get"], guide: "business", context: "business" });
  const saved = OnboardingStateSchema.parse(await dependencies.getOnboardingState(session));
  const requireWorkspace = (ref: string | null) => {
    if (ref !== null && ref !== workspaceRef) throw new PublicError({ status: 502, code: "ONBOARDING_STATE_UNAVAILABLE", message: "The current workspace and saved onboarding do not match. Retry the read before making changes." });
  };
  if (saved.state === "saved") requireWorkspace(saved.workspace_ref);
  savedForResponse = savedView(saved, false);
  if (workspace.state === "needs_workspace") return response(interviewStep(saved, true));

  // Imports remain authoritative even for legacy CLI sessions with no draft cache.
  const onboarding = OnboardingStatusSchema.parse(await dependencies.getOnboardingStatus(session));
  if (onboarding.state !== "none") requireWorkspace(onboarding.workspace.workspace_ref);
  if (onboarding.state === "pending") return response({ state: "pending", step: "import", reason: "import_pending", section: "leads",
    actions: [`The search setup (submission ${onboarding.submission_ref}) is importing; tell the founder their search is being set up.`, SUBMIT_AND_FOLLOW],
    tools: ["targeting_onboarding_status"], guide: "step-submission", context: "targeting", receipt: onboarding });
  if (onboarding.state === "failed") return response({ state: "blocked", step: "import", reason: "import_failed", section: "leads",
    actions: ["Read targeting_onboarding_status for the saved error.",
      "Repair per references.configuration: at most three technical repairs, regenerating from fresh targeting_onboarding_context; a new idempotency_key only after a definite rejection.",
      "Ask the founder only for missing business intent, then submit with targeting_post and follow targeting_onboarding_status."],
    tools: ["targeting_onboarding_status", "business_onboarding_state", "targeting_onboarding_context", "targeting_post"],
    guide: "step-configuration", context: "targeting", receipt: onboarding });
  if (onboarding.state === "imported") {
    savedForResponse = savedView(saved, true);
    const run = RunStatusSchema.parse(await dependencies.getRunStatus(session));
    if (run.state !== "none") requireWorkspace(run.workspace.workspace_ref);
    if (run.state === "none") return response({ state: "action_required", step: "sample-review", reason: "sample_not_started", section: "leads",
      actions: ["capacity_get: confirm discovery allowance remains (when exhausted, give the reset time).",
        "sample_review_post with body {} and keep its run_ref.",
        "Tell the founder you are finding and researching five matching people, that it takes a few minutes, and that you will share each one as it lands.",
        "sample_review_progress with run_ref, then with the returned cursor and wait_seconds 25 until terminal; narrate each new lead in one line.",
        "When terminal, call next_step."],
      tools: ["capacity_get", "sample_review_post", "sample_review_progress"], guide: "step-sample", context: "sample-review", receipt: onboarding });
    if (run.state === "queued" || run.state === "running") return response({ state: "pending", step: "sample-review", reason: "sample_pending", section: "leads",
      actions: [`sample_review_progress with run_ref ${run.run_ref}, then with the returned cursor and wait_seconds 25 until terminal. Narrate each newly researched lead in one line.`,
        "One request at a time: no sleeps and never POST again to check progress.", "When terminal, call next_step."],
      tools: ["sample_review_progress"], guide: "step-sample", context: "sample-review", receipt: run });
    if (run.state === "failed") return response({ state: "blocked", step: "sample-review", reason: "sample_failed", section: "leads",
      actions: ["sample_review_get to read the failure and any saved evidence.",
        "Explain it plainly. Retry once with sample_review_post only for a technical research failure; for exhausted allowance give the reset time.",
        "Offer to continue with outreach setup using saved leads while the search waits."],
      tools: ["sample_review_get", "sample_review_post"], guide: "step-sample-failed", context: "sample-review", receipt: run });
    // Sample acceptance is not persisted. A saved campaign is the evidence that
    // the founder moved past the sample; without one the sample is the resting
    // point, which is also where a lead-only founder stays.
    if (workspaceRef === null) throw new Error("Missing workspace reference");
    const campaign = WorkspaceCampaignResult.parse(await dependencies.workspaceCampaign(session, { operation: "status", payload: { workspace: workspaceRef } }));
    requireWorkspace(campaign.workspace_ref);
    if (campaign.state === "unconfigured") {
      const { hubspot, sync } = await readCrm(dependencies, session, workspaceRef);
      return response({ state: "review", step: "sample-review", reason: "sample_ready_for_founder_review", section: "leads",
        actions: ["Show the researched leads from receipt.leads (sample_review_get only if you need more): your read first, then person, company, grade, LinkedIn URL, fit rationale and evidence gaps.",
          "Ask one question: does this confirm the targeting, or what should change? A change goes through summary_context task targeting or research-criteria, then a new sample.",
          crmAction(hubspot, sync),
          "Close Section 1 in at most six lines (target, the leads and their grade mix, the CRM result), then ask whether to set up LinkedIn outreach now; yes: summary_context task campaigns."],
        tools: ["sample_review_get", "crm_get", "crm_post", "crm_mapping_context", "crm_patch", "crm_sync_start", "crm_sync_status", "summary_context"],
        guide: "step-review", context: "sample-review", receipt: run });
    }
    const receipt = { state: campaign.state, outreach_enabled: campaign.outreach_enabled, version_ref: campaign.version_ref,
      preparation: campaign.preparation?.state ?? null, blockers: campaign.blockers };
    // The campaigns guide with its references is ~300 KB; inlining it on every
    // resume stalls chat connectors. Return the workspace resume guide and let
    // the client fetch the campaigns guide when the founder works on it.
    const tools = ["campaigns_get", "summary_context"];
    const campaignStep = (state: Step["state"], reason: string, action: string) =>
      response({ state, step: "campaign", reason, section: "outreach", actions: [action, "For changes or approval read summary_context task campaigns first."],
        tools, guide: "summary", context: "campaigns", receipt });
    if (campaign.state === "active") return campaignStep("complete", "campaign_active", "Onboarding is complete: help with the founder's request instead of restarting setup; campaigns_get has the live campaign.");
    if (campaign.state === "paused") return campaignStep("action_required", "campaign_paused", "The saved campaign is paused: read campaigns_get and explain why; resume only with the founder's explicit approval.");
    if (campaign.preparation?.state === "pending") return campaignStep("pending", "campaign_preparing", "Campaign preparation is running: read campaigns_get until it is ready or failed.");
    if (campaign.preparation?.state === "failed") return campaignStep("blocked", "campaign_preparation_failed", "Campaign preparation failed: read campaigns_get for its errors and repair them.");
    return campaignStep("action_required", "campaign_draft", `Resume the saved campaign draft with campaigns_get and continue to its exact preview and approval.${campaign.blockers.length ? ` Blockers: ${campaign.blockers.join(", ")}.` : ""}`);
  }
  if (saved.state === "none" || !saved.draft_ready) return response(interviewStep(saved, false));
  const revision = saved.revision;
  if (!saved.configuration) return response({ state: "action_required", step: "configuration", reason: "configuration_needed", section: "leads",
    actions: ["Tell the founder in one line that you are building their search and research rules.",
      "Read targeting_onboarding_context (generation rules, configuration schema, context_version).",
      "Generate icp_config and scout_overlay from the saved draft per references.configuration; copy contract_version and context_version unchanged.",
      `Save the unchanged draft with the configuration via business_onboarding_save (expected_revision ${revision}).`,
      "Submit once with targeting_post {draft, configuration, expected_revision returned by that save, idempotency_key: one stable key you keep}.",
      SUBMIT_AND_FOLLOW],
    tools: ["targeting_onboarding_context", "business_onboarding_save", "targeting_post", "targeting_onboarding_status"],
    guide: "step-configuration", context: "targeting" });
  return response({ state: "action_required", step: "submission", reason: "configuration_saved", section: "leads",
    actions: [`Submit once with targeting_post using the saved draft and configuration, expected_revision ${revision} and ${saved.idempotency_key ? `the saved idempotency_key ${saved.idempotency_key}` : "one new stable idempotency_key you keep"}.`,
      SUBMIT_AND_FOLLOW],
    tools: ["targeting_post", "targeting_onboarding_status"], guide: "step-submission", context: "targeting" });
}
