// Azure app-only (client-credentials) Microsoft Graph mail.
//
// The interactive mail flow in /api/email sends as the signed-in user via
// `/me/sendMail` using their delegated `provider_token`. An inbound webhook
// (POST /api/leads/intake) has no signed-in user, so it can't reuse that path.
// Instead we authenticate the app itself with the client-credentials grant and
// send from a fixed mailbox via `/users/{sender}/sendMail`.
//
// Prerequisites (one-time, done by an Azure admin — not something code can do):
//   1. Grant the app registration the *application* permission
//      `Mail.Send` (Microsoft Graph) and click "Grant admin consent".
//      This can be added to the SAME app registration that already powers the
//      delegated login flow.
//   2. Pick a sender mailbox (a real/licensed or shared mailbox) and set
//      GRAPH_MAIL_SENDER to its UPN, e.g. "noreply@saldo.se".
//
// Required env vars:
//   AZURE_AD_TENANT_ID      (already present — reused)
//   AZURE_AD_CLIENT_ID      (already present — reused)
//   AZURE_AD_CLIENT_SECRET  (already present — reused)
//   GRAPH_MAIL_SENDER       (new — the mailbox to send from)

interface CachedToken {
  accessToken: string
  // epoch ms at which we should stop trusting the token
  expiresAt: number
}

let cached: CachedToken | null = null

/**
 * True when every env var needed for app-only sending is present. The intake
 * endpoint uses this to degrade gracefully: if it returns false, the lead is
 * still stored and the notification is marked "skipped" rather than failing
 * the request.
 */
export function isAppGraphConfigured(): boolean {
  return Boolean(
    process.env.AZURE_AD_TENANT_ID &&
      process.env.AZURE_AD_CLIENT_ID &&
      process.env.AZURE_AD_CLIENT_SECRET &&
      process.env.GRAPH_MAIL_SENDER,
  )
}

async function getAppGraphToken(): Promise<string> {
  // Reuse a still-valid token (Graph app tokens last ~60–90 min). Refresh a
  // little early to avoid using one that expires mid-request.
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.accessToken
  }

  const tenantId = process.env.AZURE_AD_TENANT_ID
  const clientId = process.env.AZURE_AD_CLIENT_ID
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Azure app credentials are not configured")
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  })

  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Azure token request failed (${response.status}): ${errorText}`,
    )
  }

  const json = (await response.json()) as {
    access_token: string
    expires_in: number
  }

  cached = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  }

  return json.access_token
}

export interface AppGraphMailInput {
  to: string[]
  subject: string
  html: string
  /** Optional Reply-To (e.g. the lead submitter's address). */
  replyTo?: string | null
  /** Override the sender mailbox; defaults to GRAPH_MAIL_SENDER. */
  sender?: string
}

/**
 * Send an HTML email from the configured app mailbox via Microsoft Graph.
 * Throws on any failure (missing config, token error, non-2xx from Graph).
 */
export async function sendAppGraphMail({
  to,
  subject,
  html,
  replyTo,
  sender,
}: AppGraphMailInput): Promise<void> {
  const fromMailbox = sender ?? process.env.GRAPH_MAIL_SENDER
  if (!fromMailbox) {
    throw new Error("GRAPH_MAIL_SENDER is not configured")
  }
  if (to.length === 0) {
    throw new Error("At least one recipient is required")
  }

  const token = await getAppGraphToken()

  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  }

  if (replyTo && replyTo.trim()) {
    message.replyTo = [{ emailAddress: { address: replyTo.trim() } }]
  }

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      fromMailbox,
    )}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Microsoft Graph sendMail failed (${response.status}): ${errorText}`,
    )
  }
}
