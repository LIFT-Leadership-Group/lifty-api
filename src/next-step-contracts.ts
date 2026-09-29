import { z } from "zod";

export const NextStepSchema = z.object({
  state: z.enum(["action_required", "pending", "blocked", "review", "complete"]),
  step: z.enum(["business", "interview", "configuration", "submission", "import", "sample-review", "campaign"]),
  reason: z.string().min(1),
  workspace_ref: z.string().nullable(),
  recommended_tools: z.array(z.string()).max(6),
  guide: z.record(z.string(), z.unknown()),
  saved: z.record(z.string(), z.unknown()).nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type NextStep = z.infer<typeof NextStepSchema>;
