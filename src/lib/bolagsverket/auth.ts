// =====================================================================
// Bolagsverket — OAuth2 Client Credentials token flow
// =====================================================================
// Token endpoint (per Bolagsverket onboarding email):
//   POST https://portal.api.bolagsverket.se/oauth2/token
//   grant_type=client_credentials
// Credentials come from the encrypted zip Bolagsverket sent (client_id +
// client_secret), stored ONLY in env — never in the repo or memory.
//
// Tokens are cached in-module until shortly before expiry so we don't mint a
// new one per request (the API allows 60 calls/min; token reuse keeps us well
// under any auth-endpoint limits).

const TOKEN_ENDPOINT =
  process.env.BOLAGSVERKET_TOKEN_ENDPOINT ??
  "https://portal.api.bolagsverket.se/oauth2/token"

// Scope string. The devportal lists the exact scope for the Värdefulla
// Datamängder API; override via env once confirmed. Default mirrors the
// documented client-credentials example.
const SCOPE = process.env.BOLAGSVERKET_SCOPE ?? "vardefulla-datamangder:read"

// Refresh this many ms BEFORE the real expiry, to avoid using a token that
// dies mid-flight.
const EXPIRY_SKEW_MS = 30_000

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number // seconds
  scope?: string
}

let cached: { token: string; expiresAt: number } | null = null

function credentials(): { id: string; secret: string } {
  const id = process.env.BOLAGSVERKET_CLIENT_ID
  const secret = process.env.BOLAGSVERKET_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error(
      "Bolagsverket credentials missing. Set BOLAGSVERKET_CLIENT_ID and " +
        "BOLAGSVERKET_CLIENT_SECRET (from the decrypted Bolagsverket zip).",
    )
  }
  return { id, secret }
}

/**
 * Return a valid access token, minting (and caching) a new one when the
 * cache is empty or near expiry.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now) {
    return cached.token
  }

  const { id, secret } = credentials()

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Client credentials sent via HTTP Basic per RFC 6749 §2.3.1.
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: SCOPE,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Bolagsverket token error (${response.status}): ${text}`,
    )
  }

  const data = (await response.json()) as TokenResponse
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  return cached.token
}

/** Clear the cached token (useful in tests or after a 401). */
export function clearTokenCache(): void {
  cached = null
}
