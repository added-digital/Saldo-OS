// Header notification bell. Mirrors supabase/migrations/00073_notifications.sql.
// Not in the generated Database type yet, so queries cast results to this.

export type NotificationType = "engagement_mention"

export interface AppNotification {
  id: string
  recipient_id: string
  actor_id: string | null
  actor_name: string | null
  type: NotificationType
  engagement_id: string | null
  customer_name: string | null
  read_at: string | null
  created_at: string
}
