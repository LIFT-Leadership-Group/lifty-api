// LIF-1292: a failed campaign test sample names why it failed. The database
// stores the composer's coded failure (`lifty_preparation_failure_v1`); this
// module turns it into one founder-facing sentence the agent can relay.

export const TEST_FAILURE_CODES = [
  "composition_held", "composition_configuration_invalid", "composition_context_unavailable",
  "composition_context_mismatch", "composition_templates_unavailable", "composition_approaches_unavailable",
  "composition_research_mismatch", "composition_receipt_invalid", "composition_quality_hold", "composition_unexpected",
] as const;
export const TEST_FAILURE_STAGES = ["identity", "version", "sender_identity", "compose", "signing"] as const;

export interface TestFailure {
  code: typeof TEST_FAILURE_CODES[number];
  stage?: typeof TEST_FAILURE_STAGES[number];
  position?: number;
  cause?: string;
  http_status?: number;
  message?: string;
}

/** Template readiness problems arrive as `TemplateReadiness.<issue>` causes. */
const READINESS_PREFIX = "TemplateReadiness.";

function templatesMessage(failure: TestFailure): string {
  const step = failure.position ? ` in step ${failure.position}` : "";
  const issue = failure.cause?.startsWith(READINESS_PREFIX) ? failure.cause.slice(READINESS_PREFIX.length) : undefined;
  switch (issue) {
    case "undeclared_slot":
      return `A saved template${step} uses a {placeholder} Lifty cannot fill. Use {first_name}, {company} or a declared slot, then preview again.`;
    case "duplicate_id":
      return `Two saved templates${step} share the same id. Give each template its own id, then preview again.`;
    case "incomplete_email_route":
    case "missing_broad_route":
      return `The saved templates${step} do not cover every opener or route the sequence needs. Add the missing variant, then preview again.`;
    case "unparseable_template":
      return `A saved template${step} could not be read. Save the template text again, then preview again.`;
    default:
      return `The saved templates${step} cannot be composed as written. Check that step, then preview again.`;
  }
}

/** The AgentAPI error classes Jobs names as `cause` (LIF-1445). */
const WRITER_OUTPUT_CAUSE = "AgentApiSchemaError";
const SERVICE_CAUSES = new Set(["AgentBusyError", "AgentApiHttpError"]);

/** A failure AgentAPI reported: the writer's output failed its schema (a
 * refusal or invalid draft, usually fine on the next try), or the writing
 * service itself was busy or unavailable. */
function writerMessage(failure: TestFailure): string | undefined {
  const status = failure.http_status;
  if (failure.cause === WRITER_OUTPUT_CAUSE || status === 400)
    return "The writer did not return a usable draft for this lead. Nothing was saved or sent; previewing again usually works, and report it if it keeps happening.";
  if (status === 429 || (status !== undefined && status >= 500) || (status === undefined && SERVICE_CAUSES.has(failure.cause ?? "")))
    return "Lifty's writing service is busy or unavailable right now, so this draft was not written. Nothing was saved or sent; preview again in a few minutes.";
  if (status !== undefined)
    return "Lifty could not reach its writing service, so this draft was not written. Nothing was saved or sent; report it if it repeats.";
  return undefined;
}

export function testFailureMessage(failure: TestFailure): string {
  const writer = writerMessage(failure);
  if (writer) return writer;
  switch (failure.code) {
    case "composition_templates_unavailable":
      return templatesMessage(failure);
    case "composition_receipt_invalid":
      return "The writer returned copy that did not fit the saved campaign. Nothing was saved or sent; previewing again usually works.";
    case "composition_quality_hold":
      return `A draft${failure.position ? ` for step ${failure.position}` : ""} did not pass Lifty's quality check. Adjust that step's template or instructions, then preview again.`;
    case "composition_context_unavailable":
      return "Lifty's writing setup for this channel is unavailable right now. Nothing was saved or sent; preview again later.";
    case "composition_context_mismatch":
    case "composition_research_mismatch":
      return "The lead's saved research or the business details changed while the preview ran. Run a new preview.";
    case "composition_configuration_invalid":
      return "The campaign's writing settings do not match its mode. Check the writing mode and the saved templates, then preview again.";
    case "composition_approaches_unavailable":
      return "No LinkedIn approach is active for this workspace, so the first message cannot be written.";
    case "composition_held":
      return "The writer did not return a draft for this lead. Nothing was saved or sent; preview again, and report it if it repeats.";
    case "composition_unexpected":
      if (failure.stage === "sender_identity")
        return "The sending mailbox's name could not be verified, so templates that use {sender_first_name} cannot be filled.";
      if (failure.stage === "signing") return "The sender's saved email signature could not be added to this draft.";
      if (failure.stage === "identity") return "This preview's saved inputs no longer match the campaign. Run a new preview.";
      return "Something failed while preparing this draft. Nothing was saved or sent; preview again, and report it if it repeats.";
  }
}
