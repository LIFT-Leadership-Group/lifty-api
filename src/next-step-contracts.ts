import { z } from "zod";
import { InterviewGatesSchema } from "./interview-gates.js";

export const NextStepSchema = z.object({
  state: z.enum(["action_required", "pending", "blocked", "review", "complete"]),
  step: z.enum(["business", "interview", "configuration", "submission", "import", "sample-review", "campaign"]),
  reason: z.string().min(1),
  section: z.enum(["leads", "outreach"]).describe("Section 1 (leads: interview, search, sample, CRM) or Section 2 (outreach)."),
  actions: z.array(z.string().min(1)).min(1).max(8).describe("What to do now, in order. Tool names are MCP names."),
  gates: InterviewGatesSchema.nullable().describe("Interview decisions still missing, during the interview only."),
  workspace_ref: z.string().nullable(),
  recommended_tools: z.array(z.string()).max(10),
  guide: z.record(z.string(), z.unknown()).describe("The current step's short playbook and only the references it needs."),
  context_task: z.string().nullable().describe("Stage whose full guide summary_context returns, for edge cases the playbook does not cover."),
  saved: z.record(z.string(), z.unknown()).nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type NextStep = z.infer<typeof NextStepSchema>;
