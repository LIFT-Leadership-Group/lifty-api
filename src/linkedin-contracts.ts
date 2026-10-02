import { z } from "zod";

// Shared by the LinkedIn campaign operations. Identity connect/status
// contracts live in identity-contracts.ts.
export const LinkedinWorkspace = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const LinkedinTimezone = z.string().min(1).max(100).refine(value => {
  // Reject fixed-offset strings; SQL validates against pg_timezone_names too.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Choose a valid IANA timezone.");
export const LinkedinPolicy = z.object({
  invitations_per_day: z.literal(5), invitations_per_7_days: z.literal(25), messages_per_day: z.literal(5),
  weekdays: z.array(z.number().int().min(1).max(5)).length(5).refine(value => value.join(",") === "1,2,3,4,5"),
  start: z.literal("09:00"), end: z.literal("17:00"),
  spacing_minutes: z.array(z.number().int()).length(2).refine(value => value.join(",") === "15,45"),
}).strict();
