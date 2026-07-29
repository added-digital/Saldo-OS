// Types for the task board (uppgifter) — ad-hoc work outside the recurring
// services. Mirrors supabase/migrations/00105_tasks.sql. These tables aren't in
// the generated Database type yet, so queries cast results to these.

export interface TaskStatus {
  id: string
  key: string
  label: string
  sort_order: number
  is_done: boolean
  color: string | null
}

export interface TaskCategory {
  id: string
  key: string
  label: string
  sort_order: number
  color: string | null
}

/** One row of the `task_board` view. */
export interface TaskBoardRow {
  id: string
  title: string
  /** The note field on the card: what the task actually involves. */
  description: string | null

  status_id: string | null
  status_key: string | null
  status_label: string | null
  status_sort: number | null
  status_is_done: boolean | null
  status_changed_at: string | null

  category_id: string | null
  category_key: string | null
  category_label: string | null
  category_color: string | null

  /** Optional — plenty of tasks are internal and belong to no customer. */
  customer_id: string | null
  customer_name: string | null

  assignee_id: string | null
  assignee_name: string | null
  created_by: string | null
  created_by_name: string | null

  deadline: string | null
  is_overdue: boolean

  /** Manual column ordering; null = never dragged. */
  position: number | null
  created_at: string
  updated_at: string
}

export interface TaskActivity {
  id: string
  task_id: string
  actor_id: string | null
  type: "created" | "status_changed" | "assigned" | "comment" | "field_changed"
  from_status_id: string | null
  to_status_id: string | null
  message: string | null
  metadata: { from?: string | null; to?: string | null } | null
  created_at: string
}
