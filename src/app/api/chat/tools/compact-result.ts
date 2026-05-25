/**
 * Tool-result compactor.
 *
 * Every tool result is JSON-stringified and embedded into the Anthropic
 * `messages` array, then re-sent on every subsequent iteration of the tool
 * loop. Large arrays (per-consultant breakdowns, per-customer monthly
 * rollups, document chunk text) accumulate fast and have been pushing
 * requests past the 200K input-token limit.
 *
 * This module trims known-fat fields BEFORE they hit the message array. It
 * is intentionally conservative on the first pass — caps are generous, the
 * model still sees enough data to answer, and any trimming is announced via
 * a `_compacted` marker so the model can say "showing top N" or call the
 * tool again with a filter.
 *
 * Adding a new tool: register a CompactionRule in TOOL_RULES below. If no
 * rule is registered, the generic fallback still catches obvious whales.
 */

export type CompactionStats = {
  /** Length of JSON.stringify(originalResult). */
  before: number;
  /** Length of JSON.stringify(compactedResult). */
  after: number;
  /** Field paths that were trimmed (for logging). */
  trimmed_fields: string[];
};

type CompactionRule = {
  /** Truncate arrays at the given top-level field name to N items. */
  arrayCaps?: Array<{ field: string; limit: number }>;
  /**
   * Truncate strings at the given path to N characters. Supported paths:
   *   "field"             → string at top level
   *   "field[*].subfield" → for every item in array `field`, truncate the
   *                          string at `subfield`
   */
  stringCaps?: Array<{ path: string; limit: number }>;
};

const GENERIC_ARRAY_CAP = 50;
const GENERIC_STRING_CAP = 2000;

const TOOL_RULES: Record<string, CompactionRule> = {
  resolve_customer: {
    arrayCaps: [{ field: "matches", limit: 10 }],
  },
  resolve_consultant: {
    arrayCaps: [{ field: "matches", limit: 10 }],
  },
  get_kpi_by_consultant: {
    arrayCaps: [{ field: "consultants", limit: 30 }],
  },
  get_kpi_summary: {
    // by_customer entries are sorted by total_turnover desc inside the tool,
    // so slicing to 30 keeps the most relevant rows. by_month is naturally
    // capped at 12 by the calendar, so no rule needed there.
    arrayCaps: [{ field: "by_customer", limit: 30 }],
  },
  get_consultant_customers: {
    arrayCaps: [{ field: "customers", limit: 30 }],
  },
  get_cost_center_details: {
    arrayCaps: [
      { field: "customers", limit: 30 },
      { field: "consultants", limit: 30 },
    ],
  },
  list_cost_centers: {
    arrayCaps: [{ field: "cost_centers", limit: 50 }],
  },
  search_invoices: {
    arrayCaps: [{ field: "invoices", limit: 30 }],
  },
  search_documents: {
    arrayCaps: [{ field: "chunks", limit: 6 }],
    stringCaps: [{ path: "chunks[*].excerpt", limit: 800 }],
  },
  get_customer_overview: {
    arrayCaps: [
      { field: "active_contracts_sample", limit: 5 },
      { field: "recent_activities", limit: 5 },
    ],
  },
};

/**
 * Trim arrays and long strings inside a tool result and return both the
 * compacted result and a stats summary suitable for logging. Errors and
 * primitives are passed through untouched.
 */
export function compactToolResult(
  toolName: string,
  result: unknown,
): { compacted: unknown; stats: CompactionStats } {
  const beforeJson = safeStringify(result);
  const before = beforeJson.length;

  // Errors, nulls, primitives and top-level arrays → leave alone. We only
  // trim the well-known object-shaped tool results.
  if (
    result == null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    "error" in (result as Record<string, unknown>)
  ) {
    return {
      compacted: result,
      stats: { before, after: before, trimmed_fields: [] },
    };
  }

  const clone = safeClone(result) as Record<string, unknown>;
  const trimmed: string[] = [];

  const rule = TOOL_RULES[toolName];

  if (rule?.arrayCaps) {
    for (const { field, limit } of rule.arrayCaps) {
      if (capArrayField(clone, field, limit)) {
        trimmed.push(`${field}>${limit}`);
      }
    }
  }

  if (rule?.stringCaps) {
    for (const { path, limit } of rule.stringCaps) {
      if (capStringAtPath(clone, path, limit)) {
        trimmed.push(`${path}>${limit}chars`);
      }
    }
  }

  // Generic safety net — only runs on top-level fields not already covered
  // by a specific rule. This protects future tools that haven't been added
  // to TOOL_RULES yet.
  const coveredArrayFields = new Set(
    rule?.arrayCaps?.map((cap) => cap.field) ?? [],
  );
  for (const key of Object.keys(clone)) {
    if (coveredArrayFields.has(key)) continue;
    const value = clone[key];
    if (Array.isArray(value) && value.length > GENERIC_ARRAY_CAP) {
      const total = value.length;
      clone[key] = value.slice(0, GENERIC_ARRAY_CAP);
      appendCompactionNote(clone, key, total, GENERIC_ARRAY_CAP);
      trimmed.push(`${key}>${GENERIC_ARRAY_CAP}(generic)`);
    } else if (typeof value === "string" && value.length > GENERIC_STRING_CAP) {
      clone[key] = `${value.slice(0, GENERIC_STRING_CAP)}…[truncated]`;
      trimmed.push(`${key}>${GENERIC_STRING_CAP}chars(generic)`);
    }
  }

  const afterJson = safeStringify(clone);
  return {
    compacted: clone,
    stats: { before, after: afterJson.length, trimmed_fields: trimmed },
  };
}

// ---------------------------------------------------------------------------
// Helpers (intentionally not exported — keep the public surface tiny)
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}

/**
 * JSON round-trip clone. Tool results are JSON-able by contract (they get
 * stringified into Anthropic tool_result blocks anyway), so this is safe and
 * avoids aliasing surprises if the caller still references `result` for
 * other purposes (e.g. extracting `sources` for the response payload).
 */
function safeClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/** Cap a top-level array field on `obj`. Returns true if trimming happened. */
function capArrayField(
  obj: Record<string, unknown>,
  field: string,
  limit: number,
): boolean {
  const value = obj[field];
  if (!Array.isArray(value) || value.length <= limit) return false;
  const total = value.length;
  obj[field] = value.slice(0, limit);
  appendCompactionNote(obj, field, total, limit);
  return true;
}

/**
 * Trim a string at a path. Supports:
 *   "field"             → top-level string
 *   "field[*].subfield" → string at `subfield` on every item of array `field`
 */
function capStringAtPath(
  obj: Record<string, unknown>,
  path: string,
  limit: number,
): boolean {
  const arrayMatch = path.match(/^([^[]+)\[\*\]\.(.+)$/);
  if (arrayMatch) {
    const [, arrayKey, subKey] = arrayMatch;
    const arr = obj[arrayKey];
    if (!Array.isArray(arr)) return false;
    let didTrim = false;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const subValue = record[subKey];
      if (typeof subValue === "string" && subValue.length > limit) {
        record[subKey] = `${subValue.slice(0, limit)}…[truncated]`;
        didTrim = true;
      }
    }
    return didTrim;
  }

  const value = obj[path];
  if (typeof value !== "string" || value.length <= limit) return false;
  obj[path] = `${value.slice(0, limit)}…[truncated]`;
  return true;
}

/**
 * Attach (or append to) the `_compacted` marker so the model knows the
 * returned list is a subset of the full result and can phrase its answer
 * accordingly ("showing the top 30 of 87 consultants by turnover…").
 */
function appendCompactionNote(
  obj: Record<string, unknown>,
  field: string,
  totalCount: number,
  shownCount: number,
): void {
  const note = {
    field,
    total_count: totalCount,
    shown_count: shownCount,
  };
  const existing = obj._compacted;
  if (Array.isArray(existing)) {
    existing.push(note);
  } else {
    obj._compacted = [note];
  }
}
