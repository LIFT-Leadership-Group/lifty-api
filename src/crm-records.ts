import { z } from "zod";

export const CrmRecordsQuerySchema = z
  .object({ run_ref: z.uuid().optional() })
  .strict();
const Lead = z
  .object({
    lead_ref: z.uuid(),
    name: z.string(),
    company: z.string().nullable(),
    crm_contact_id: z.string().nullable(),
    crm_company_id: z.string().nullable(),
  })
  .strict();
const Available = z
  .object({
    state: z.literal("available"),
    workspace_ref: z.uuid(),
    run_ref: z.uuid(),
    sync_state: z.enum(["queued", "running", "succeeded", "failed"]),
    portal_id: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .nullable(),
    leads: z.array(Lead).max(2_000),
  })
  .strict();
const None = z
  .object({ state: z.literal("none"), workspace_ref: z.uuid() })
  .strict();
export const CrmRecordsDataSchema = z.discriminatedUnion("state", [
  None,
  Available,
]);
export const CrmRecordsSchema = z.discriminatedUnion("state", [
  None,
  Available.extend({
    leads: z
      .array(
        Lead.extend({
          contact_url: z.url().nullable(),
          company_url: z.url().nullable(),
          contact_status: z.enum([
            "verified",
            "missing_record",
            "record_unavailable",
            "identity_mismatch",
          ]),
          company_status: z.enum([
            "verified",
            "missing_record",
            "record_unavailable",
            "identity_mismatch",
          ]),
        }),
      )
      .max(2_000),
  }),
]);
export type CrmRecords = z.infer<typeof CrmRecordsSchema>;
