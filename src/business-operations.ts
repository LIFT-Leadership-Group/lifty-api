import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import * as contracts from "./business-contracts.js";
const Empty = z.object({}).strict();
export const businessOperationDefinitions = {
  business: {
    get: {
      method: "GET",
      route: "/v1/workspace/business",
      response: contracts.BusinessGetSchema,
      request: Empty,
      rpc: "get_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Read the versioned commercial profile and confirmed-value checkpoint. No workspace returns workspace:null and profile:null.",
    },
    post: {
      method: "POST",
      route: "/v1/workspace/business",
      response: contracts.BusinessPostResultSchema,
      request: contracts.BusinessPostSchema,
      rpc: "create_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Create a workspace, profile version 1, empty voice and paused research schedule. A replay returns the selected existing workspace or the successor created for the selected retired predecessor. Creates no setup draft and activates no work.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/business",
      response: contracts.BusinessGetSchema,
      request: contracts.BusinessPatchSchema,
      rpc: "patch_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Synchronously edit supplied profile fields using expected_version. Omitted fields stay unchanged; null clears optional fields; arrays replace. Append a revision without regenerating criteria or changing approved campaigns.",
    },
  },
  targeting: {
    get: {
      method: "GET",
      route: "/v1/workspace/targeting",
      response: contracts.TargetingGetSchema,
      request: Empty,
      rpc: "get_lifty_targeting",
      code: "TARGETING_INVALID",
      description:
        "Read the versioned neutral targeting resource, including every existing search lane. Search allocation is platform policy.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/targeting",
      response: contracts.TargetingGetSchema,
      request: contracts.TargetingPatchSchema,
      rpc: "patch_lifty_targeting",
      code: "TARGETING_INVALID",
      description:
        "Synchronously patch lanes by their stable id, preserving omitted filters. Filters affect the next discovery. Persona changes require regenerated_criteria and both expected versions; targeting and criteria commit atomically.",
    },
  },
  "research-criteria": {
    get: {
      method: "GET",
      route: "/v1/workspace/research-criteria",
      response: contracts.CriteriaGetSchema,
      request: Empty,
      rpc: "get_lifty_research_criteria",
      code: "CRITERIA_INVALID",
      description:
        "Read the current versioned Scout criteria, independent input contract and qualification policy. Hand-tuned is a revision attribute.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/research-criteria",
      response: contracts.CriteriaGetSchema,
      request: contracts.CriteriaPatchSchema,
      rpc: "patch_lifty_research_criteria",
      code: "CRITERIA_INVALID",
      description:
        "Synchronously append an explicitly supplied criteria revision with expected_version. A text edit supplies source_versions; hand-tuned revisions can be explicitly edited. New research uses the new version; saved history retains its version.",
    },
  },
  "commercial-voice": {
    get: {
      method: "GET",
      route: "/v1/workspace/commercial-voice",
      response: contracts.VoiceGetSchema,
      request: Empty,
      rpc: "get_lifty_commercial_voice",
      code: "VOICE_INVALID",
      description:
        "Read general commercial tone and do/avoid rules. Empty voice exists at version 0.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/commercial-voice",
      response: contracts.VoiceGetSchema,
      request: contracts.VoicePatchSchema,
      rpc: "patch_lifty_commercial_voice",
      code: "VOICE_INVALID",
      description:
        "Synchronously edit general voice with expected_version (0 for the first edit). Arrays replace; null clears tone. New drafts use it, approved campaign pins remain, and Scout never receives voice.",
    },
  },
  setup: {
    get_draft: {
      method: "GET",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDraftGetSchema,
      request: Empty,
      rpc: "get_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Read the workspace-owned server draft, generated criteria, gates and immutable submission state. The server draft is the only setup source.",
    },
    patch_draft: {
      method: "PATCH",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDraftGetSchema,
      request: contracts.SetupDraftPatchSchema,
      rpc: "save_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Save the current workspace draft with expected_version and generated_criteria or null. Bind generated criteria to the resulting draft version. Submitted drafts are immutable. Does not submit or activate work.",
    },
    delete_draft: {
      method: "DELETE",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDiscardSchema,
      request: Empty,
      rpc: "discard_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Discard setup only before submission. The database refuses discarding a submitted draft. Does not delete Business resources or history.",
    },
    generation_context: {
      method: "GET",
      route: "/v1/workspace/setup/context",
      cli: { operation: "context" },
      response: contracts.SetupContextSchema,
      request: Empty,
      rpc: "get_lifty_setup_context",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Read the confirmed profile, saved server draft, current Scout base text/version and API-owned generation guidance. Generate only Scout criteria.",
    },
    post: {
      method: "POST",
      route: "/v1/workspace/setup",
      response: contracts.SetupStatusSchema,
      request: contracts.SetupPostSchema,
      rpc: "submit_lifty_setup",
      code: "SETUP_INVALID",
      description:
        "Submit expected_draft_version once: atomically create targeting and criteria at version 1. The same version replays the exact receipt. Changed profile, draft or base returns a conflict; an existing different setup cannot be replaced. Never activates research or outreach.",
    },
    status: {
      method: "GET",
      route: "/v1/workspace/setup/status",
      cli: { operation: "status" },
      response: contracts.SetupStatusSchema,
      request: Empty,
      rpc: "get_lifty_setup_status",
      code: "SETUP_INVALID",
      description:
        "Read the persisted setup_ref and exact source/resource versions. Imported confirms both resources exist; a lost submit response is resolved by this read.",
    },
  },
} as const;
export type BusinessOperationKey =
  `${keyof typeof businessOperationDefinitions}.${string}`;
export const businessEntries = () =>
  Object.entries(businessOperationDefinitions).flatMap(
    ([resource, operations]) =>
      Object.entries(operations).map(([action, definition]) => ({
        key: `${resource}.${action}`,
        resource,
        action,
        definition,
      })),
  );
export function validateBusinessRequest(
  schema: z.ZodType,
  input: unknown,
  code: string,
) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
    code: `schema_${issue.code}`,
    path: `/${issue.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
    message: "This field does not match the current resource contract.",
    suggestion:
      issue.code === "unrecognized_keys"
        ? "Remove fields absent from the published operation schema."
        : "Use the field type, bounds and provenance shown in the current operation schema.",
  }));
  throw new PublicError({
    status: 422,
    code,
    message: "Repair these fields using the current resource schema.",
    issues,
  });
}
const messages: Record<string, string> = {
  VERSION_CONFLICT:
    "The resource changed. Read its current version and apply your intended edit again.",
  WORKSPACE_FORBIDDEN: "You do not belong to this workspace.",
  WORKSPACE_SELECTION_REQUIRED:
    "Choose one of your workspaces before continuing.",
  WORKSPACE_SUSPENDED: "This workspace is suspended. Contact LIFT support.",
  WORKSPACE_NOT_READY: "Create a workspace before configuring Business.",
  ALREADY_CONFIGURED:
    "This workspace already has a setup from another draft version.",
  SETUP_ALREADY_SUBMITTED: "The submitted setup draft is immutable.",
  SETUP_STALE:
    "The profile, draft or Scout base changed. Read setup context and generate fresh criteria.",
  CRITERIA_REGENERATION_REQUIRED:
    "Persona edits require regenerated criteria and its current version in the same request.",
  PROFILE_INVALID: "Repair the commercial profile fields.",
  TARGETING_INVALID: "Repair the targeting fields.",
  CRITERIA_INVALID: "Repair the Scout criteria fields.",
  VOICE_INVALID: "Repair the voice fields.",
  SETUP_DRAFT_INVALID: "Repair the setup draft fields.",
  SETUP_INVALID:
    "Complete the setup gates and generated criteria before submission.",
};
export async function executeBusinessOperation(
  session: AuthSession,
  key: string,
  workspaceRef: string | null,
  payload?: unknown,
): Promise<unknown> {
  const entry = businessEntries().find((entry) => entry.key === key);
  if (!entry) throw new Error("Unknown Business operation");
  // Normalize the approved simple employee range to the lossless adapter form.
  const normalized =
    key === "targeting.patch" &&
    payload &&
    typeof payload === "object" &&
    "lanes" in payload
      ? {
          ...payload,
          lanes: (payload.lanes as { company?: { employees?: unknown } }[]).map(
            (lane) => {
              const employees = lane.company?.employees;
              return employees &&
                typeof employees === "object" &&
                "min" in employees
                ? {
                    ...lane,
                    company: {
                      ...lane.company,
                      employees: { ranges: [employees] },
                    },
                  }
                : lane;
            },
          ),
        }
      : payload;
  const args =
    key === "business.post"
      ? { p_payload: normalized, p_workspace_id: workspaceRef }
      : key === "setup.post"
        ? {
            p_workspace_id: workspaceRef,
            p_expected_draft_version: (
              normalized as { expected_draft_version: number }
            ).expected_draft_version,
          }
        : {
            p_workspace_id: workspaceRef,
            ...(entry.definition.method === "PATCH"
              ? { p_payload: normalized }
              : {}),
          };
  let result: { data: unknown; error: unknown };
  try {
    result = await (
      session.client as {
        rpc(
          name: string,
          args: Record<string, unknown>,
        ): Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc(entry.definition.rpc, args);
  } catch (cause) {
    throw new PublicError({
      status: 502,
      code: "BUSINESS_UNAVAILABLE",
      message:
        "Business state could not be verified. Read the resource before retrying a write.",
      cause,
    });
  }
  if (result.error) {
    const error = result.error as {
      message?: string;
      code?: string;
      details?: string;
    };
    const token = error.message?.toUpperCase() ?? "";
    const known = Object.hasOwn(messages, token);
    let detail: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(error.details ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        detail = parsed as Record<string, unknown>;
    } catch {
      /* never expose raw provider diagnostics */
    }
    const issues = z
      .array(contracts.RepairIssueSchema)
      .max(20)
      .safeParse(detail.issues);
    const current = z
      .number()
      .int()
      .nonnegative()
      .safeParse(detail.current_version);
    const stale = z
      .array(z.enum(["profile", "draft", "base", "criteria"]))
      .max(4)
      .safeParse(detail.stale_sources);
    throw new PublicError({
      status: known
        ? token === "WORKSPACE_FORBIDDEN"
          ? 403
          : token.endsWith("INVALID")
            ? 422
            : 409
        : error.code === "PT401"
          ? 401
          : 502,
      code: known
        ? token
        : error.code === "PT401"
          ? "UNAUTHORIZED"
          : "BUSINESS_UNAVAILABLE",
      message: known
        ? messages[token]!
        : "Business state could not be verified. Read the resource before retrying a write.",
      ...(known && issues.success ? { issues: issues.data } : {}),
      ...(known && current.success ? { current_version: current.data } : {}),
      ...(known && stale.success ? { stale_sources: stale.data } : {}),
    });
  }
  const context =
    key === "setup.generation_context"
      ? contracts.SetupContextDataSchema.safeParse(result.data)
      : null;
  if (context && !context.success)
    throw new PublicError({
      status: 502,
      code: "BUSINESS_UNAVAILABLE",
      message: "The setup context could not be verified.",
    });
  const data = context?.success
    ? {
        ...context.data,
        generation_rules: contracts.SETUP_GENERATION_RULES,
        criteria_schema: z.toJSONSchema(contracts.CriteriaValuesSchema, {
          io: "input",
        }),
        draft_schema: z.toJSONSchema(contracts.SetupDraftSchema, {
          io: "input",
        }),
      }
    : result.data;
  const parsed = entry.definition.response.safeParse(data);
  if (!parsed.success)
    throw new PublicError({
      status: 502,
      code: "BUSINESS_UNAVAILABLE",
      message: "The resource response could not be verified. Retry its read.",
    });
  return parsed.data;
}
