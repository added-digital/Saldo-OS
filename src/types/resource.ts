// Types for the Beläggning board (resursplanering).
// Mirrors supabase/migrations/00112_resource_planning.sql. These tables aren't
// in the generated Database type yet, so queries cast results to these.

export type ResourceCadence = "manad" | "kvartal" | "ar" | "vid_behov"

/**
 * Whether a piece of work can be moved when a month is overloaded.
 * `lagstadgad` has an external date behind it; `intern` is ours to reschedule.
 * This is the distinction the board exists to support.
 */
export type ResourceHardness = "lagstadgad" | "intern"

export interface ResourceStatus {
  id: string
  key: string
  label: string
  sort_order: number
  is_done: boolean
  color: string | null
}

/**
 * One recurring thing a customer needs, derived from what has actually been
 * logged and then confirmed by a human. `confirmed_at === null` is the whole
 * point of the capture step: it separates "we think" from "we know".
 */
export interface CustomerRecurringWork {
  id: string
  customer_id: string
  label: string
  source_activity: string | null
  cadence: ResourceCadence
  typical_hours: number | null
  hardness: ResourceHardness
  source: "derived" | "manual"
  is_active: boolean
  confirmed_at: string | null
  confirmed_by: string | null
  created_at: string
  updated_at: string
}

/** One row of the `resource_board(year, month)` function. */
export interface ResourceBoardRow {
  customer_id: string
  customer_name: string
  fortnox_customer_number: string | null

  /** Owns the relationship — from customers.fortnox_cost_center. */
  kundansvarig_id: string | null
  kundansvarig_name: string | null

  /** Does the work. A different axis from kundansvarig; may be unset. */
  assignee_id: string | null
  assignee_name: string | null

  status_id: string | null
  status_key: string | null
  status_label: string | null
  status_sort: number | null
  status_is_done: boolean | null

  /**
   * Mean of the last 3 complete months. Crude by design: ±38% per customer,
   * ~17% once summed over a portfolio, which is the number the board is for.
   */
  lopande_estimate_hours: number
  /** Manager's override. NULL = the estimate stands unargued-with. */
  planned_hours: number | null
  /** planned_hours ?? lopande_estimate_hours — what the column totals use. */
  effective_hours: number

  recurring_total: number
  recurring_confirmed: number

  /** Händelsestyrd work landing in this month, from the engagement dates. */
  event_label: string | null
  event_due_date: string | null
  event_hardness: ResourceHardness | null

  /** Avtalad månadsavgift, for the planerat-vs-avtalat overlay. */
  fixed_monthly_price: number | null
  note: string | null
  position: number | null
}
