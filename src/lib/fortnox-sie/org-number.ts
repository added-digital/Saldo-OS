/**
 * Swedish organisation-number helpers, shared by the SIE connect-time guard
 * (callback route) and the sync-time backstop (sync.ts).
 *
 * The same legal entity can be written several ways across systems:
 *   - "556677-8899"     (hyphenated, the canonical human form)
 *   - "5566778899"      (10 digits, no hyphen — how SIE #ORGNR often arrives)
 *   - "165566778899"    (12 digits, "16" century prefix Fortnox sometimes adds)
 *   - " 556677-8899 "   (stray whitespace from a CSV import)
 *
 * `normalizeOrgNumber` collapses all of these to a bare 10-digit string so
 * two values can be compared safely. `orgNumbersMatch` only returns true on a
 * definite match — if either side is missing/unparseable it returns false, so
 * callers can decide how to treat the "can't tell" case explicitly rather than
 * silently passing.
 */

/**
 * Reduce an org number to its canonical 10-digit form, or null if it doesn't
 * contain a usable 10-digit identifier.
 */
export function normalizeOrgNumber(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;

  // Keep digits only — drops hyphens, spaces, and any stray punctuation.
  let digits = raw.replace(/\D/g, "");

  // Strip a leading "16" century prefix that turns the standard 10-digit
  // number into 12 digits (Fortnox occasionally emits this form).
  if (digits.length === 12 && digits.startsWith("16")) {
    digits = digits.slice(2);
  }

  // A valid Swedish org/personal number is exactly 10 digits. Anything else
  // we treat as unparseable rather than guessing.
  return digits.length === 10 ? digits : null;
}

/**
 * True only when both inputs normalise to the same 10-digit identifier.
 * Returns false if either side is missing or unparseable — the caller is
 * responsible for deciding whether "unknown" should block or allow.
 */
export function orgNumbersMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeOrgNumber(a);
  const nb = normalizeOrgNumber(b);
  return na !== null && nb !== null && na === nb;
}
