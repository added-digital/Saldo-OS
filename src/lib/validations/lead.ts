import { z } from "zod/v4"

// Inbound contact-form payload from the public website. The site sends a
// `fields` object plus envelope metadata. `name`, `company`, `message` are
// required; `email`, `phone` are optional. Unknown keys in `meta` are kept
// as-is for forensic/debug value.
export const leadIntakeSchema = z.object({
  formName: z.string().trim().min(1).max(100).optional().default("contact"),
  fields: z.object({
    name: z.string().trim().min(1, "name is required").max(200),
    company: z.string().trim().min(1, "company is required").max(200),
    message: z.string().trim().min(1, "message is required").max(5000),
    email: z
      .email("invalid email")
      .max(320)
      .optional()
      .or(z.literal(""))
      .nullable(),
    phone: z.string().trim().max(50).optional().or(z.literal("")).nullable(),
  }),
  pagePath: z.string().trim().max(500).optional().nullable(),
  submittedAt: z.iso.datetime({ offset: true }).optional().nullable(),
  meta: z.record(z.string(), z.unknown()).optional().default({}),
})

export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>

// Manually added lead from the "Add lead" dialog. Company info is either
// autofilled from a Bolagsverket org.nr lookup or typed by hand; the primary
// contact mirrors a customer card. `bolagsverketData` carries the raw lookup
// snapshot when the org number was verified.
export const manualLeadSchema = z.object({
  company: z.string().trim().min(1, "company is required").max(200),
  orgNumber: z
    .string()
    .trim()
    .regex(/^\d{10}(\d{2})?$/, "org number must be 10 or 12 digits")
    .optional()
    .or(z.literal(""))
    .nullable(),
  companyLegalForm: z.string().trim().max(100).optional().or(z.literal("")).nullable(),
  addressStreet: z.string().trim().max(200).optional().or(z.literal("")).nullable(),
  addressPostalCode: z.string().trim().max(20).optional().or(z.literal("")).nullable(),
  addressCity: z.string().trim().max(100).optional().or(z.literal("")).nullable(),
  contactName: z.string().trim().min(1, "contact name is required").max(200),
  contactRole: z.string().trim().max(100).optional().or(z.literal("")).nullable(),
  email: z.email("invalid email").max(320).optional().or(z.literal("")).nullable(),
  phone: z.string().trim().max(50).optional().or(z.literal("")).nullable(),
  note: z.string().trim().max(5000).optional().or(z.literal("")).nullable(),
  bolagsverketData: z.record(z.string(), z.unknown()).optional().nullable(),
})

export type ManualLeadInput = z.infer<typeof manualLeadSchema>
