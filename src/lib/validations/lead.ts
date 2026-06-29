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
