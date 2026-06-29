import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"

import { createAdminClient } from "@/lib/supabase/admin"
import { leadIntakeSchema } from "@/lib/validations/lead"
import { isAppGraphConfigured, sendAppGraphMail } from "@/lib/mail/graph-app"
import type {
  WebsiteLead,
  WebsiteLeadNotificationStatus,
} from "@/types/database"

// Inbound lead intake from the public marketing site.
//
// Contract (see the report / README for full details):
//   POST /api/leads/intake
//   Authorization: Bearer <LEADS_INTAKE_TOKEN>
//   Content-Type: application/json
//   Idempotency-Key: <opaque string>   (optional, recommended on retries)
//
// OS is the system of record: it stores the lead (visible in the Leads view)
// and sends a notification email via the Azure app-only Graph flow. If mail
// isn't configured yet (admin consent pending), the lead is still stored and
// the notification is marked "skipped" — the request still succeeds.

export const runtime = "nodejs"

function unauthorized(message: string) {
  return NextResponse.json({ ok: false, error: "unauthorized", message }, {
    status: 401,
  })
}

/** Constant-time bearer-token check against LEADS_INTAKE_TOKEN. */
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.LEADS_INTAKE_TOKEN
  if (!expected) return false

  const header = request.headers.get("authorization") ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return false

  const provided = match[1].trim()
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim()
  return request.headers.get("x-real-ip")
}

function notificationHtml(lead: {
  name: string
  company: string
  message: string
  email: string | null
  phone: string | null
  formName: string
  pagePath: string | null
  submittedAt: string | null
}): string {
  const row = (label: string, value: string | null) =>
    value
      ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:4px 0;color:#111827;">${value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</td></tr>`
      : ""

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827;">
    <p style="margin:0 0 12px;font-size:16px;font-weight:600;">New website lead</p>
    <table style="border-collapse:collapse;margin-bottom:16px;">
      ${row("Name", lead.name)}
      ${row("Company", lead.company)}
      ${row("Email", lead.email)}
      ${row("Phone", lead.phone)}
      ${row("Form", lead.formName)}
      ${row("Page", lead.pagePath)}
      ${row("Submitted", lead.submittedAt)}
    </table>
    <p style="margin:0 0 4px;color:#6b7280;">Message</p>
    <div style="white-space:pre-wrap;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">${lead.message
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</div>
    ${
      lead.email
        ? `<p style="margin:16px 0 0;color:#6b7280;">Reply directly to this email to reach ${lead.name}.</p>`
        : ""
    }
  </div>`
}

export async function POST(request: NextRequest) {
  try {
    // 1. Auth — shared bearer token.
    if (!isAuthorized(request)) {
      return unauthorized("Missing or invalid bearer token.")
    }

    // 2. Defensive JSON parse.
    let raw: string
    try {
      raw = await request.text()
    } catch {
      return NextResponse.json(
        { ok: false, error: "invalid_body", message: "Could not read body." },
        { status: 400 },
      )
    }
    if (!raw.trim()) {
      return NextResponse.json(
        { ok: false, error: "invalid_body", message: "Empty request body — expected JSON." },
        { status: 400 },
      )
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return NextResponse.json(
        { ok: false, error: "invalid_body", message: "Invalid JSON." },
        { status: 400 },
      )
    }

    // 3. Schema validation.
    const result = leadIntakeSchema.safeParse(parsedJson)
    if (!result.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "validation_error",
          message: "One or more fields are invalid.",
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 422 },
      )
    }

    const { formName, fields, pagePath, submittedAt, meta } = result.data
    const email = fields.email?.trim() ? fields.email.trim() : null
    const phone = fields.phone?.trim() ? fields.phone.trim() : null

    const recaptchaScore =
      typeof (meta as Record<string, unknown>).recaptchaScore === "number"
        ? ((meta as Record<string, unknown>).recaptchaScore as number)
        : null

    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() || null

    const supabase = createAdminClient()

    // 4. Idempotency — if this key was already stored, return the existing lead
    // instead of creating a duplicate.
    if (idempotencyKey) {
      const { data: existing } = await supabase
        .from("website_leads")
        .select("id, notification_status")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle()

      const existingRow = existing as Pick<
        WebsiteLead,
        "id" | "notification_status"
      > | null
      if (existingRow) {
        return NextResponse.json(
          {
            ok: true,
            leadId: existingRow.id,
            duplicate: true,
            notificationStatus: existingRow.notification_status,
          },
          { status: 200 },
        )
      }
    }

    // 5. Store the lead (service-role insert bypasses RLS).
    const { data: inserted, error: insertError } = await supabase
      .from("website_leads")
      .insert({
        form_name: formName,
        name: fields.name,
        company: fields.company,
        message: fields.message,
        email,
        phone,
        page_path: pagePath ?? null,
        submitted_at: submittedAt ?? null,
        recaptcha_score: recaptchaScore,
        meta: meta as Record<string, unknown>,
        idempotency_key: idempotencyKey,
        source_ip: clientIp(request),
      } as never)
      .select("id")
      .single()

    const insertedRow = inserted as Pick<WebsiteLead, "id"> | null
    if (insertError || !insertedRow) {
      console.error("Lead insert failed:", insertError)
      return NextResponse.json(
        {
          ok: false,
          error: "server_error",
          message: insertError?.message ?? "Failed to store lead.",
        },
        { status: 500 },
      )
    }

    const leadId = insertedRow.id

    // 6. Notification email — best-effort. The lead is already stored; a send
    // failure (or missing config) never fails the request.
    const recipientEnv =
      process.env.LEADS_NOTIFICATION_EMAIL?.trim() || ""
    const recipients = recipientEnv
      .split(/[,;]+/)
      .map((address) => address.trim())
      .filter(Boolean)

    let notificationStatus: WebsiteLeadNotificationStatus = "skipped"
    let notificationError: string | null = null

    if (!isAppGraphConfigured() || recipients.length === 0) {
      notificationStatus = "skipped"
      notificationError = !isAppGraphConfigured()
        ? "Azure app-only mail not configured (Mail.Send consent / GRAPH_MAIL_SENDER)."
        : "LEADS_NOTIFICATION_EMAIL is not set."
    } else {
      try {
        await sendAppGraphMail({
          to: recipients,
          subject: `New website lead: ${fields.name} (${fields.company})`,
          html: notificationHtml({
            name: fields.name,
            company: fields.company,
            message: fields.message,
            email,
            phone,
            formName,
            pagePath: pagePath ?? null,
            submittedAt: submittedAt ?? null,
          }),
          // Staff can reply straight to the submitter when they left an email.
          replyTo: email,
        })
        notificationStatus = "sent"
      } catch (sendError) {
        notificationStatus = "failed"
        notificationError =
          sendError instanceof Error ? sendError.message : "Unknown send error"
        console.error(`Lead notification send failed for ${leadId}:`, notificationError)
      }
    }

    await supabase
      .from("website_leads")
      .update({
        notification_status: notificationStatus,
        notification_recipient: recipients.join(", ") || null,
        notification_error: notificationError,
      } as never)
      .eq("id", leadId)

    return NextResponse.json(
      { ok: true, leadId, duplicate: false, notificationStatus },
      { status: 201 },
    )
  } catch (error) {
    console.error("Lead intake error:", error)
    return NextResponse.json(
      {
        ok: false,
        error: "server_error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
