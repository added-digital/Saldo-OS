// Types for the Beläggning board (resursplanering).
// Mirrors supabase/migrations/00112_resource_planning.sql,
// 00113_resource_capacity.sql and 00114_resource_structure.sql. These tables
// aren't in the generated Database type yet, so queries cast results to these.

export type ResourceCadence = "manad" | "kvartal" | "ar" | "vid_behov"

/**
 * Whether a piece of work can be moved when a month is overloaded.
 * `lagstadgad` has an external date behind it; `intern` is ours to reschedule.
 * This is the distinction the board exists to support.
 */
export type ResourceHardness = "lagstadgad" | "intern"

/** Why a card carries no usable estimate. NULL = it does. */
export type ResourceAssessmentReason =
  | "ny_kund"
  | "vilande"
  | "ingen_historik"
  | "for_lite_historik"

export type ResourceEventKind = "bokslut" | "ink2" | "loner" | "moms" | "agi"

export type AbsenceType = "semester" | "sjuk" | "foraldraledig" | "ovrigt"

export type MomsPeriod = "manad" | "kvartal" | "helar"
export type BookkeepingFrequency = "manad" | "kvartal"

/**
 * The structural facts behind löpande work. Each one turns into a dated anchor:
 * momsperiod into the 12th (26th for large filers), payroll into the 25th and
 * the AGI date. All nullable — an unknown fact draws no anchor rather than a
 * guessed one.
 */
export interface CustomerStructure {
  moms_period: MomsPeriod | null
  has_payroll: boolean | null
  payroll_run_day: number | null
  bookkeeping_frequency: BookkeepingFrequency | null
}

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
  /** In how many of the last 12 months this activity was logged. */
  months_seen: number | null
  /** How many months of history the proposal was measured over. */
  months_total: number | null
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

  /** Structural, near-stable part of the estimate. */
  lopande_estimate_hours: number
  /** Bokslut, INK2, årsredovisning — lumpy, anchored to the fiscal year. */
  handelsestyrt_estimate_hours: number
  /** Manager's override. NULL = the estimate stands unargued-with. */
  planned_hours: number | null
  /** planned_hours ?? (löpande + händelsestyrt) — what the totals use. */
  effective_hours: number

  recurring_total: number
  recurring_confirmed: number
  /** Up to three labels answering "vad ska göras". */
  top_activities: string[]

  /** The month's hardest-to-move anchor for this customer. */
  event_label: string | null
  event_due_date: string | null
  event_hardness: ResourceHardness | null
  event_kind: ResourceEventKind | null

  assessment_reason: ResourceAssessmentReason | null
  last_reported_date: string | null
  history_months: number

  /** Avtalad månadsavgift, for the planerat-vs-avtalat overlay. */
  fixed_monthly_price: number | null
  note: string | null
  position: number | null
}

/** One row of `resource_month_events(year, month)`. */
export interface ResourceMonthEvent {
  customer_id: string
  kind: ResourceEventKind
  label: string
  due_date: string
  hardness: ResourceHardness
  rank: number
}

/**
 * One row of `resource_capacity(year, month)`.
 *
 * available_hours = (arbetsdagar − helgdagar − planerad frånvaro)
 *                   × (weekly_hours / 5) × billable_target
 */
export interface ResourceCapacityRow {
  profile_id: string
  profile_name: string | null
  workdays: number
  holiday_days: number
  absence_days: number
  weekly_hours: number
  billable_target: number
  available_hours: number
}

export interface Absence {
  id: string
  profile_id: string
  start_date: string
  end_date: string
  type: AbsenceType
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SwedishHoliday {
  date: string
  name: string
  is_public_holiday: boolean
}

/**
 * Load thresholds, shared by the header bar and every column bar so the same
 * number never reads as two different states.
 */
export function loadTone(load: number): "neutral" | "success" | "warning" | "error" {
  if (load > 1.1) return "error"
  if (load > 0.95) return "warning"
  if (load >= 0.7) return "success"
  return "neutral"
}
