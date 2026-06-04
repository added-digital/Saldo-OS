import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { system } from "@/config/system"
import { CampaignTemplateEmail } from "@/emails/campaign-template"
import { ContentTemplateEmail } from "@/emails/content-template"
import {
  generateTrackingId,
  injectTracking,
} from "@/lib/email/tracking"
import { render } from "@react-email/components"

type EmailRecipientType = "customers" | "contacts" | "manual"

interface EmailRecipientPayload {
  email: string
  name?: string | null
  type?: EmailRecipientType
  customer_id?: string | null
  contact_id?: string | null
  data?: Record<string, unknown>
}

interface EmailRequest {
  // New shape (preferred): one call carries the whole batch.
  recipients?: EmailRecipientPayload[]
  // Legacy shape (still supported): single recipient via `to` + metadata.
  to?: string | string[]
  recipient_metadata?: {
    type?: EmailRecipientType
    name?: string | null
    customer_id?: string | null
    contact_id?: string | null
  }
  template: "content" | "plain" | "campaign"
  data: Record<string, unknown>
  mode?: "send" | "preview"
  deliveryMode?: "grouped" | "separate"
  // Optional campaign grouping. Either an existing campaign's id, or a name to
  // pick-or-create one for the sending user. Ignored in preview mode.
  campaign_id?: string | null
  campaign_name?: string | null
}

function htmlToPreview(html: string, maxLength = 240): string {
  const text = html
    // Strip <style>/<script> blocks first so their bodies don't leak in.
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    // Replace block-level tags with newlines so paragraphs separate cleanly.
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    // Drop remaining tags.
    .replace(/<[^>]+>/g, " ")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim()

  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}…`
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return fallback
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item).trim())
      .filter((item) => item.length > 0)
  }

  if (typeof value === "string") {
    return value
      .split(/[\r\n,;]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  return []
}

type EmailRenderResult = {
  subject: string
  html: string
}

type TemplateRenderer = (data: Record<string, unknown>, appUrl: string) => Promise<EmailRenderResult>

function normalizeBaseUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) return ""
  return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate
}

function toHttpsUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) return ""
  if (/^https?:\/\//i.test(candidate)) return normalizeBaseUrl(candidate)
  return normalizeBaseUrl(`https://${candidate}`)
}

function resolveAppUrl(request: NextRequest, data: Record<string, unknown>): string {
  const fromPayload = asString(data.appUrl, "")
  if (fromPayload) {
    return normalizeBaseUrl(fromPayload)
  }

  const publicAppUrl = process.env.NEXT_PUBLIC_APP_URL
  if (publicAppUrl?.trim()) {
    return normalizeBaseUrl(publicAppUrl)
  }

  const vercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercelProductionUrl?.trim()) {
    return toHttpsUrl(vercelProductionUrl)
  }

  const vercelUrl = process.env.VERCEL_URL
  if (vercelUrl?.trim()) {
    return toHttpsUrl(vercelUrl)
  }

  const requestOrigin = request.nextUrl.origin
  if (requestOrigin?.trim()) {
    return normalizeBaseUrl(requestOrigin)
  }

  return normalizeBaseUrl(system.url)
}

const templateRenderers: Record<EmailRequest["template"], TemplateRenderer> = {
  content: async (data, appUrl) => {
    const title = asString(data.title, "Information from Saldo")
    const subject = asString(data.subject, title)
    const paragraphs = asStringArray(data.paragraphs)
    const html = await render(
      ContentTemplateEmail({
        title,
        previewText: asString(data.previewText, title),
        greeting: asString(data.greeting, ""),
        paragraphs,
        ctaLabel: asString(data.ctaLabel, ""),
        ctaUrl: asString(data.ctaUrl, ""),
        footnote: asString(data.footnote, ""),
        appUrl,
        brandName: asString(data.brandName, system.companyName),
      })
    )
    return { subject, html }
  },
  campaign: async (data, appUrl) => {
    const title = asString(data.title, "Information from Saldo")
    const subject = asString(data.subject, title)
    const paragraphs = asStringArray(data.paragraphs)
    const html = await render(
      CampaignTemplateEmail({
        title,
        previewText: asString(data.previewText, title),
        greeting: asString(data.greeting, ""),
        paragraphs,
        ctaLabel: asString(data.ctaLabel, ""),
        ctaUrl: asString(data.ctaUrl, ""),
        footnote: asString(data.footnote, ""),
        appUrl,
        brandName: asString(data.brandName, system.companyName),
      })
    )
    return { subject, html }
  },
  plain: async (data) => {
    const subject = asString(data.subject, "Message from Saldo")
    const body = asString(data.body, "")
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827;">${body
      .split(/\r?\n/)
      .map((line) =>
        line.trim().length === 0
          ? "<p style=\"margin:0 0 12px;\">&nbsp;</p>"
          : `<p style=\"margin:0 0 12px;\">${line
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")}</p>`
      )
      .join("")}</div>`
    return { subject, html }
  },
}

async function sendMicrosoftGraphMail(
  providerToken: string,
  recipients: string[],
  subject: string,
  html: string,
) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: "HTML",
          content: html,
        },
        toRecipients: [
          ...recipients.map((recipient) => ({
            emailAddress: {
              address: recipient,
            },
          })),
        ],
      },
      saveToSentItems: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Microsoft Graph sendMail failed (${response.status}): ${errorText}`)
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse defensively: an empty or non-JSON body (aborted/duplicate request,
    // a beacon, a malformed client call) otherwise throws "Unexpected end of
    // JSON input" and surfaces as a server error instead of a clean 400.
    let body: EmailRequest
    try {
      const raw = await request.text()
      if (!raw.trim()) {
        return NextResponse.json(
          { error: "Empty request body — expected JSON." },
          { status: 400 },
        )
      }
      body = JSON.parse(raw) as EmailRequest
    } catch {
      return NextResponse.json(
        { error: "Invalid request body — expected JSON." },
        { status: 400 },
      )
    }
    const { template, data, mode = "send" } = body
    const deliveryMode = "separate"

    // Normalise to a single shape: { email, name, type, customer_id, contact_id, data }[].
    const recipientPayloads: EmailRecipientPayload[] = (() => {
      if (Array.isArray(body.recipients) && body.recipients.length > 0) {
        return body.recipients.map((entry) => ({
          email: typeof entry.email === "string" ? entry.email.trim() : "",
          name: entry.name ?? null,
          type: entry.type,
          customer_id: entry.customer_id ?? null,
          contact_id: entry.contact_id ?? null,
          data: entry.data,
        }))
      }
      // Legacy: `to` + `recipient_metadata` (single-recipient flow).
      return asStringArray(body.to).map((email) => ({
        email,
        name: body.recipient_metadata?.name ?? null,
        type: body.recipient_metadata?.type,
        customer_id: body.recipient_metadata?.customer_id ?? null,
        contact_id: body.recipient_metadata?.contact_id ?? null,
      }))
    })()

    if (recipientPayloads.length === 0) {
      return NextResponse.json({ error: "At least one recipient is required" }, { status: 400 })
    }

    const invalidRecipients = recipientPayloads
      .map((entry) => entry.email)
      .filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    if (invalidRecipients.length > 0) {
      return NextResponse.json(
        {
          error: "Invalid recipient email address",
          invalid_recipients: invalidRecipients,
        },
        { status: 400 }
      )
    }

    const renderTemplate = templateRenderers[template]
    if (!renderTemplate) {
      return NextResponse.json({ error: "Invalid template" }, { status: 400 })
    }

    const baseData = data ?? {}
    const appUrl = resolveAppUrl(request, baseData)

    // Render template per recipient (each may carry its own personalisation
    // payload). The first render also serves as the canonical "batch body"
    // we store on mail_send_batches — typically the differences between
    // recipients are only name swaps, so this is a faithful representation
    // of what was sent.
    type RenderedRecipient = EmailRecipientPayload & {
      rendered: EmailRenderResult
    }
    const rendered: RenderedRecipient[] = []
    for (const recipient of recipientPayloads) {
      const mergedData = { ...baseData, ...(recipient.data ?? {}) }
      const result = await renderTemplate(mergedData, appUrl)
      rendered.push({ ...recipient, rendered: result })
    }

    const batchSubject = rendered[0].rendered.subject
    const batchHtml = rendered[0].rendered.html
    const batchPreview = htmlToPreview(batchHtml)

    if (mode === "preview") {
      return NextResponse.json({
        success: true,
        subject: batchSubject,
        html: batchHtml,
        recipients: rendered.map((entry) => entry.email),
      })
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    const providerToken = session?.provider_token
    if (!providerToken) {
      return NextResponse.json(
        {
          error: "Microsoft token missing",
          message: "Please sign in again with Microsoft to enable sending mail.",
        },
        { status: 412 }
      )
    }

    // Resolve the optional campaign grouping. Either an existing campaign id
    // we can confirm the user owns (the select is RLS-scoped, so a foreign id
    // returns nothing and is ignored), or a name to pick-or-create for them.
    let resolvedCampaignId: string | null = null
    {
      const rawId =
        typeof body.campaign_id === "string" ? body.campaign_id.trim() : ""
      const rawName =
        typeof body.campaign_name === "string" ? body.campaign_name.trim() : ""
      if (rawId) {
        const { data: owned } = await supabase
          .from("mail_campaigns")
          .select("id")
          .eq("id", rawId)
          .maybeSingle()
        resolvedCampaignId = (owned as { id: string } | null)?.id ?? null
      } else if (rawName) {
        const existing = await supabase
          .from("mail_campaigns")
          .select("id")
          .ilike("name", rawName)
          .maybeSingle()
        let id = (existing.data as { id: string } | null)?.id ?? null
        if (!id) {
          const created = await supabase
            .from("mail_campaigns")
            .insert({ user_id: user.id, name: rawName } as never)
            .select("id")
            .single()
          if (created.error) {
            // Likely a race on the unique(user_id, lower(name)) index — the
            // campaign was created by a concurrent send; re-select it.
            const reselect = await supabase
              .from("mail_campaigns")
              .select("id")
              .ilike("name", rawName)
              .maybeSingle()
            id = (reselect.data as { id: string } | null)?.id ?? null
          } else {
            id = (created.data as { id: string }).id
          }
        }
        resolvedCampaignId = id
      }
    }

    // Insert the batch row first so we have a batch_id to link the per-
    // recipient sent_emails rows to.
    const { data: batchData, error: batchError } = await supabase
      .from("mail_send_batches")
      .insert({
        user_id: user.id,
        subject: batchSubject,
        body_preview: batchPreview,
        body_html: batchHtml,
        template_key: template,
        delivery_mode: deliveryMode,
        recipient_count: recipientPayloads.length,
        campaign_id: resolvedCampaignId,
      } as never)
      .select("id")
      .single()

    const batchRow = batchData as { id: string } | null
    if (batchError || !batchRow) {
      console.error("Failed to insert mail_send_batches row:", batchError)
      return NextResponse.json(
        {
          error: "Failed to record batch",
          message: batchError?.message ?? "Unknown error",
        },
        { status: 500 }
      )
    }
    const batchId = batchRow.id

    type LogRow = {
      user_id: string
      batch_id: string
      subject: string
      body_preview: string
      recipient_email: string
      recipient_name: string | null
      recipient_type: EmailRecipientType
      customer_id: string | null
      contact_id: string | null
      template_key: string
      delivery_mode: string
      status: "sent" | "failed"
      error_message: string | null
      tracking_id: string
    }
    const sentLogRows: LogRow[] = []
    let sentCount = 0
    const failures: Array<{ recipient: string; message: string }> = []

    for (const entry of rendered) {
      const recipientType: EmailRecipientType =
        entry.type === "customers" || entry.type === "contacts"
          ? entry.type
          : "manual"

      // Pre-allocate the tracking_id so we can both inject it into the
      // outbound HTML AND persist it on the sent_emails row. The two values
      // must match — that's how the /api/track/{open,click}/[id] routes
      // find which sent_email a given event belongs to.
      const trackingId = generateTrackingId()
      const trackedHtml = injectTracking(entry.rendered.html, {
        trackingId,
        appUrl,
      })

      try {
        await sendMicrosoftGraphMail(
          providerToken,
          [entry.email],
          entry.rendered.subject,
          trackedHtml,
        )
        sentCount += 1
        sentLogRows.push({
          user_id: user.id,
          batch_id: batchId,
          subject: entry.rendered.subject,
          body_preview: htmlToPreview(entry.rendered.html),
          recipient_email: entry.email,
          recipient_name: entry.name ?? null,
          recipient_type: recipientType,
          customer_id: entry.customer_id ?? null,
          contact_id: entry.contact_id ?? null,
          template_key: template,
          delivery_mode: deliveryMode,
          status: "sent",
          error_message: null,
          tracking_id: trackingId,
        })
      } catch (sendError) {
        const message =
          sendError instanceof Error ? sendError.message : "Unknown send error"
        console.error(`Send to ${entry.email} failed:`, message)
        failures.push({ recipient: entry.email, message })
        sentLogRows.push({
          user_id: user.id,
          batch_id: batchId,
          subject: entry.rendered.subject,
          body_preview: htmlToPreview(entry.rendered.html),
          recipient_email: entry.email,
          recipient_name: entry.name ?? null,
          recipient_type: recipientType,
          customer_id: entry.customer_id ?? null,
          contact_id: entry.contact_id ?? null,
          template_key: template,
          delivery_mode: deliveryMode,
          status: "failed",
          error_message: message,
          tracking_id: trackingId,
        })
      }
    }

    if (sentLogRows.length > 0) {
      const { error: logError } = await supabase
        .from("sent_emails")
        .insert(sentLogRows as never)
      if (logError) {
        console.error("Failed to log sent_emails:", logError)
      }
    }

    // Update the denormalised counts on the batch (best-effort).
    await supabase
      .from("mail_send_batches")
      .update({
        sent_count: sentCount,
        failed_count: failures.length,
      } as never)
      .eq("id", batchId)

    if (sentCount === 0 && failures.length > 0) {
      return NextResponse.json(
        {
          error: "All sends failed",
          message: failures[0].message,
          batch_id: batchId,
          failures,
        },
        { status: 502 }
      )
    }

    return NextResponse.json({
      success: true,
      batch_id: batchId,
      subject: batchSubject,
      recipients: rendered.map((entry) => entry.email),
      delivery_mode: deliveryMode,
      sent_count: sentCount,
      failure_count: failures.length,
      failures,
    })
  } catch (error) {
    console.error("Email send error:", error)
    return NextResponse.json(
      {
        error: "Failed to send email",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
