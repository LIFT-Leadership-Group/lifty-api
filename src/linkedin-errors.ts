import { z } from "zod";
import { PublicError } from "./errors.js";

const messages: Record<string, string> = {
  linkedin_user_required: "Sign in to LIFTY before operating LinkedIn.",
  linkedin_service_forbidden: "The LinkedIn service is unavailable. Contact LIFT support.",
  linkedin_workspace_forbidden: "Choose a workspace you belong to.",
  linkedin_workspace_suspended: "This workspace is paused. Resume it before activating LinkedIn.",
  unauthenticated: "Sign in to LIFTY before operating LinkedIn.",
  linkedin_confirmation_required: "Provide the current digest and explicitly confirm this operation.",
  linkedin_intent_conflict: "This connection link is already being prepared or has ended. Check status before opening another link.",
  linkedin_invalid_content: "Use a lead with a LinkedIn profile and one plain-text message of 1–3000 characters.",
  linkedin_campaign_pin_mismatch: "The campaign’s sending connection or lead changed. Use its bound connection and lead.",
  linkedin_campaign_started: "An action has already started. Inspect the campaign before changing its approved content.",
  linkedin_campaign_state: "This operation is not available in the campaign’s current state. Check status before continuing.",
  linkedin_digest_mismatch: "The campaign changed. Preview and approve its current digest.",
  linkedin_ambiguous_send: "An action has an uncertain result. Inspect status; do not resend it.",
  linkedin_target_stopped: "This lead has replied or is suppressed. Pending LinkedIn actions remain stopped.",
  linkedin_connection_mismatch: "The campaign’s account binding changed. Verify the connection before continuing.",
  linkedin_health_stale: "Refresh the LinkedIn connection status before activating the campaign.",
  linkedin_policy_changed: "The connection policy changed. Prepare, preview and approve the campaign again.",
  linkedin_outbound_disabled: "LinkedIn sending is paused. Verify the connection and explicitly activate the campaign.",
  linkedin_invalid_health: "The LinkedIn health check could not be verified. Sending remains paused.",
  linkedin_invalid_request: "Check the LinkedIn operation and required fields.",
  linkedin_invalid_timezone: "Choose a valid IANA timezone.",
  linkedin_declaration_required: "Use a personal LinkedIn account you use regularly, without another automation tool.",
  linkedin_profile_conflict: "Reconnect the LinkedIn account already bound to this workspace.",
  linkedin_identity_mismatch: "The authorized LinkedIn profile does not match the account bound to this workspace.",
  linkedin_account_taken: "This LinkedIn account is already bound to another workspace.",
  linkedin_namespace_mismatch: "The LinkedIn provider configuration changed. Contact LIFT support.",
  linkedin_intent_expired: "This connection link expired. Run the LinkedIn connect command again.",
  linkedin_callback_invalid: "This LinkedIn callback could not be verified.",
  linkedin_callback_conflict: "This connection link already refers to a different account. Run connect again.",
  linkedin_target_forbidden: "Choose a lead from this workspace.",
  linkedin_connection_forbidden: "Choose a LinkedIn connection from this workspace.",
  linkedin_campaign_forbidden: "Choose a LinkedIn campaign from this workspace.",
  linkedin_target_missing: "This lead needs a LinkedIn profile before you can prepare a campaign.",
  linkedin_approval_stale: "The campaign changed. Preview and approve its current digest.",
  linkedin_approval_required: "Preview and explicitly approve this campaign before activating it.",
  linkedin_campaign_not_draft: "Prepare a new campaign version before approving again.",
  linkedin_campaign_conflict: "This account already has a campaign for this lead. Inspect the existing campaign.",
  linkedin_execution_terminal: "This campaign has ended. Inspect its outcome before preparing another campaign.",
  linkedin_immutable_record: "An action has already been claimed or sent. Inspect its outcome before changing content.",
  linkedin_sender_unhealthy: "LinkedIn is disconnected or its health check expired. Reconnect and verify health before activating.",
  linkedin_sender_identity_mismatch: "The connected LinkedIn profile does not match the approved sender.",
  linkedin_target_suppressed: "This lead is suppressed or has replied. No pending LinkedIn action will send.",
  linkedin_target_mismatch: "The lead’s LinkedIn profile changed. Prepare and approve the campaign again.",
  linkedin_channel_inactive: "LinkedIn sending is paused. Verify the connection, then explicitly activate the campaign.",
  linkedin_recovery_required: "An action has an uncertain result. Inspect status; do not resend it.",
  linkedin_cancel_confirmation_required: "Cancel using the exact digest and explicit confirmation.",
};
export function linkedinFailure(code: string, status = 502, message = "LIFTY could not complete the LinkedIn request. Check status before trying again."): never {
  throw new PublicError({ status, code, message });
}
export function mapLinkedinRpcError(error: unknown, fallback = "LINKEDIN_CONNECTION_UNAVAILABLE"): never {
  if (error instanceof PublicError) throw error;
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const code = parsed.success ? parsed.data.code : undefined;
  const rawMessage = parsed.success ? parsed.data.message ?? "" : "";
  const message = Object.hasOwn(messages, rawMessage) ? messages[rawMessage] : undefined;
  const status = code && /^PT(400|401|403|409|410)$/.test(code) && (message || code === "PT401" || code === "PT403") ? Number(code.slice(2)) : 502;
  linkedinFailure(message ? rawMessage.toUpperCase() : fallback, status, message);
}
