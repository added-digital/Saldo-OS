// Types for the engagement / workflow board (Bokslut + INK2).
// Mirrors the schema in supabase/migrations/00066_engagements.sql. These tables
// aren't in the generated Database type yet, so queries cast results to these.

export type EngagementWorkflow = "bokslut" | "ink2"

export type ChecklistValue = "yes" | "no" | "na"

export interface EngagementStatus {
  id: string
  workflow: EngagementWorkflow
  key: string
  label: string
  sort_order: number
  is_done: boolean
  is_parked: boolean
  color: string | null
}

export interface EngagementChecklistField {
  key: string
  label: string
  group?: string
  /** 'engagement' = per fiscal year; 'customer' = durable relationship fact. */
  scope: "engagement" | "customer"
}

/** One row of the `engagement_board` view. */
export interface EngagementBoardRow {
  id: string
  customer_id: string
  customer_name: string
  org_number: string | null
  fiscal_year_end: string
  consultant_id: string | null
  consultant_name: string | null
  co_consultant_id: string | null
  co_consultant_name: string | null
  group_name: string | null

  bokslut_status_id: string | null
  bokslut_status_key: string | null
  bokslut_status_label: string | null
  bokslut_status_sort: number | null
  bokslut_status_is_done: boolean | null
  bokslut_status_changed_at: string | null

  ink2_status_id: string | null
  ink2_status_key: string | null
  ink2_status_label: string | null
  ink2_status_sort: number | null
  ink2_status_is_done: boolean | null
  ink2_status_changed_at: string | null

  deadline: string | null
  is_overdue: boolean

  bokslut_comment: string | null
  prior_year_comment: string | null
  next_year_note: string | null
  general_comment: string | null
  setup: Record<string, ChecklistValue> | null
  /** The customer's durable tags (Holdingbolag, Revisor, …) for badges. */
  customer_setup: Record<string, ChecklistValue> | null
  created_at: string
  updated_at: string
  /** Set when the bokslut card has been cleared (hidden) from the board. */
  bokslut_cleared_at: string | null
  /** Set when the INK2 card has been cleared (hidden) from the board. */
  ink2_cleared_at: string | null
  /** Manual within-column ordering for the bokslut tab (null = never ordered). */
  bokslut_position: number | null
  /** Manual within-column ordering for the INK2 tab (null = never ordered). */
  ink2_position: number | null
}

export interface EngagementActivity {
  id: string
  engagement_id: string
  actor_id: string | null
  type: "created" | "status_changed" | "comment" | "field_changed"
  workflow: EngagementWorkflow | null
  from_status_id: string | null
  to_status_id: string | null
  message: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface EngagementComment {
  id: string
  engagement_id: string
  author_id: string | null
  body: string
  created_at: string
  updated_at: string
}

export interface EngagementAttachment {
  id: string
  engagement_id: string
  storage_path: string
  file_name: string
  file_type: string | null
  file_size: number | null
  uploaded_by: string | null
  created_at: string
}
