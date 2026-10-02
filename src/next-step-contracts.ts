import { z } from "zod";
import { SetupGatesSchema } from "./business-contracts.js";

export const NextStepSchema = z
  .object({
    state: z.enum([
      "action_required",
      "pending",
      "blocked",
      "review",
      "complete",
    ]),
    step: z.enum([
      "business",
      "interview",
      "configuration",
      "submission",
      "import",
      "sample-review",
      "campaign",
    ]),
    reason: z.string().min(1),
    section: z
      .enum(["leads", "outreach"])
      .describe(
        "Section 1 (leads: interview, search, sample, CRM) or Section 2 (outreach).",
      ),
    actions: z
      .array(z.string().min(1))
      .min(1)
      .max(8)
      .describe("What to do now, in order. Tool names are MCP names."),
    gates: SetupGatesSchema.nullable().describe(
      "Interview decisions still missing, during the interview only.",
    ),
    workspace_ref: z.string().nullable(),
    recommended_tools: z.array(z.string()).max(10),
    guide: z
      .record(z.string(), z.unknown())
      .describe("The current API-owned guide for this step."),
    context_task: z
      .string()
      .nullable()
      .describe("Stage that owns the returned guide and operation catalog."),
    saved: z.record(z.string(), z.unknown()).nullable(),
    receipt: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type NextStep = z.infer<typeof NextStepSchema>;
