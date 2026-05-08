export type Role = "admin" | "team_lead" | "user"

export type CustomerStatus = "active" | "paused" | "former" | "archived" | "removed"

export type SyncStatus = "idle" | "syncing" | "error"

export type ActivityType = "meeting" | "call" | "email" | "note"

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: Role
  is_active: boolean
  team_id: string | null
  fortnox_employee_id: string | null
  fortnox_user_id: string | null
  fortnox_group_name: string | null
  fortnox_cost_center: string | null
  created_at: string
  updated_at: string
}

export interface Team {
  id: string
  name: string
  description: string | null
  lead_id: string | null
  created_at: string
  updated_at: string
}

export interface Scope {
  id: string
  key: string
  label: string
  description: string | null
  created_at: string
}

export interface UserScope {
  user_id: string
  scope_id: string
  granted_by: string | null
  granted_at: string
}

export type SyncJobStatus = "pending" | "processing" | "completed" | "failed"

export interface Customer {
  id: string
  fortnox_customer_number: string | null
  name: string
  org_number: string | null
  email: string | null
  phone: string | null
  contact_name: string | null
  address_line1: string | null
  address_line2: string | null
  zip_code: string | null
  city: string | null
  country: string | null
  status: CustomerStatus
  industry: string | null
  revenue: number | null
  employees: number | null
  office: string | null
  notes: string | null
  start_date: string | null
  fortnox_active: boolean | null
  fortnox_cost_center: string | null
  total_turnover: number | null
  invoice_count: number | null
  total_hours: number | null
  contract_value: number | null
  bolagsverket_status: string | null
  bolagsverket_registered_office: string | null
  bolagsverket_board_count: number | null
  bolagsverket_company_data: Record<string, unknown> | null
  bolagsverket_board_data: Record<string, unknown> | null
  bolagsverket_updated_at: string | null
  fortnox_raw: Record<string, unknown> | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface SyncJob {
  id: string
  status: SyncJobStatus
  progress: number
  current_step: string | null
  total_items: number
  processed_items: number
  error_message: string | null
  payload: Record<string, unknown> | null
  started_by: string | null
  step_name: string | null
  batch_phase: string | null
  batch_offset: number
  dispatch_lock: boolean
  last_dispatched_at: string | null
  nightly_chain_id: string | null
  nightly_step_index: number | null
  created_at: string
  updated_at: string
}

export interface Segment {
  id: string
  name: string
  description: string | null
  color: string
  created_at: string
  updated_at: string
}

export interface CustomerSegment {
  customer_id: string
  segment_id: string
  assigned_at: string
}

export interface CustomerWithRelations extends Customer {
  account_manager?: Pick<Profile, "id" | "full_name" | "email"> | null
  segments?: Segment[]
}

export interface CustomerKpi {
  id: string
  customer_id: string
  fortnox_customer_number: string | null
  period_type: "year" | "month"
  period_year: number
  period_month: number
  total_turnover: number
  invoice_count: number
  total_hours: number
  customer_hours: number
  absence_hours: number
  internal_hours: number
  other_hours: number
  contract_value: number
  created_at: string
  updated_at: string
}

export interface ManagerTimeKpi {
  id: string
  manager_profile_id: string
  customer_manager_profile_id: string | null
  period_year: number
  period_month: number
  total_hours: number
  customer_hours: number
  absence_hours: number
  internal_hours: number
  other_hours: number
  created_at: string
  updated_at: string
}

export interface FortnoxConnection {
  id: string
  access_token: string
  refresh_token: string
  token_expires_at: string
  fortnox_tenant_id: string | null
  connected_at: string
  connected_by: string | null
  last_sync_at: string | null
  sync_status: SyncStatus
  sync_error: string | null
  websocket_offset: string | null
  updated_at: string
}

export interface AuditLogEntry {
  id: string
  user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Record<string, unknown> | null
  ip_address: string | null
  created_at: string
}

export interface Invoice {
  id: string
  document_number: string
  customer_id: string | null
  fortnox_customer_number: string | null
  customer_name: string | null
  invoice_date: string | null
  final_pay_date: string | null
  total_vat: number | null
  total_ex_vat: number | null
  total: number | null
  balance: number | null
  currency_code: string
  created_at: string
  updated_at: string
}

export interface InvoiceRow {
  id: string
  invoice_number: string
  article_number: string | null
  article_name: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  total_ex_vat: number | null
  total: number | null
  created_at: string
}

export interface ArticleRegistry {
  id: string
  article_number: string
  article_name: string | null
  description: string | null
  unit: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface ArticleGroupMapping {
  id: string
  article_number: string
  article_name: string | null
  group_name: string
  active: boolean
  created_at: string
  updated_at: string
}

export interface CostCenter {
  id: string
  code: string
  name: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface TimeReport {
  id: string
  unique_key: string
  customer_id: string | null
  entry_type: string
  registration_code: string | null
  registration_type: string | null
  source_endpoint: string | null
  report_id: string | null
  report_date: string | null
  employee_id: string | null
  employee_name: string | null
  fortnox_customer_number: string | null
  customer_name: string | null
  project_number: string | null
  project_name: string | null
  activity: string | null
  article_number: string | null
  hours: number | null
  description: string | null
  created_at: string
  updated_at: string
}

export interface ContractAccrual {
  id: string
  fortnox_customer_number: string
  contract_number: string
  customer_name: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  status: string | null
  accrual_type: string | null
  period: string | null
  is_active: boolean
  total_ex_vat: number | null
  total: number | null
  currency_code: string
  raw_data: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface CustomerContact {
  id: string
  name: string
  first_name: string | null
  last_name: string | null
  role: string | null
  email: string | null
  phone: string | null
  linkedin: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CustomerContactLink {
  id: string
  customer_id: string
  contact_id: string
  relationship_label: string | null
  is_primary: boolean
  created_at: string
}

export interface CustomerActivity {
  id: string
  customer_id: string
  date: string
  activity_type: ActivityType
  description: string
  created_by: string | null
  created_at: string
}

export interface CustomerService {
  id: string
  customer_id: string
  service_type: string
  price: number | null
  billing_model: string | null
  start_date: string | null
  responsible_consultant: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CustomerDocumentLink {
  id: string
  customer_id: string
  document_type: string | null
  title: string
  url: string
  created_at: string
}

export interface AppSetting {
  key: string
  value: string | null
  updated_at: string
}

export interface LicensePriceListItem {
  id: string
  article_number: string
  product_name: string | null
  monthly_price: number
  comment: string | null
  created_at: string
  updated_at: string
}

export interface LicenseCustomerConfig {
  id: string
  org_number: string
  name: string | null
  fortnox_customer_number: string | null
  discount_percent: number
  fixed_price_fortnox: number | null
  fixed_price_reda: number | null
  comment: string | null
  status: string | null
  created_at: string
  updated_at: string
}

export interface MailTemplate {
  id: string
  name: string
  template_type: "plain" | "plain_os" | "default" | "campaign"
  payload: Record<string, unknown>
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Document {
  id: string
  storage_path: string
  file_name: string
  file_type: string | null
  document_type: string | null
  content_text: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface DocumentChunk {
  id: string
  document_id: string
  chunk_index: number
  chunk_text: string
  embedding: string
  created_at: string
}

export interface Conversation {
  id: string
  user_id: string
  title: string | null
  messages: Record<string, unknown>[]
  created_at: string
  updated_at: string
}

export type SentEmailStatus = "sent" | "failed"
export type SentEmailRecipientType = "customers" | "contacts" | "manual"

export interface MailSendBatch {
  id: string
  user_id: string
  subject: string
  body_preview: string | null
  body_html: string | null
  template_key: string | null
  delivery_mode: string | null
  recipient_count: number
  sent_count: number
  failed_count: number
  sent_at: string
  created_at: string
  updated_at: string
}

export interface SentEmail {
  id: string
  user_id: string
  batch_id: string | null
  subject: string
  body_preview: string | null
  body_html: string | null
  recipient_email: string
  recipient_name: string | null
  recipient_type: SentEmailRecipientType
  customer_id: string | null
  contact_id: string | null
  template_key: string | null
  delivery_mode: string | null
  status: SentEmailStatus
  error_message: string | null
  tracking_id: string
  sent_at: string
  created_at: string
  updated_at: string
}

export type EmailEventType = "open" | "click"

export interface EmailEvent {
  id: string
  sent_email_id: string
  event_type: EmailEventType
  target_url: string | null
  user_agent: string | null
  ip_address: string | null
  referrer: string | null
  created_at: string
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile
        Insert: Omit<Profile, "created_at" | "updated_at">
        Update: Partial<Omit<Profile, "id" | "created_at" | "updated_at">>
      }
      teams: {
        Row: Team
        Insert: Omit<Team, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Team, "id" | "created_at" | "updated_at">>
      }
      scopes: {
        Row: Scope
        Insert: Omit<Scope, "id" | "created_at">
        Update: Partial<Omit<Scope, "id" | "created_at">>
      }
      user_scopes: {
        Row: UserScope
        Insert: UserScope
        Update: Partial<UserScope>
      }
      customers: {
        Row: Customer
        Insert: Omit<Customer, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Customer, "id" | "created_at" | "updated_at">>
      }
      segments: {
        Row: Segment
        Insert: Omit<Segment, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Segment, "id" | "created_at" | "updated_at">>
      }
      customer_segments: {
        Row: CustomerSegment
        Insert: Omit<CustomerSegment, "assigned_at">
        Update: never
      }
      fortnox_connection: {
        Row: FortnoxConnection
        Insert: Omit<FortnoxConnection, "id" | "connected_at" | "updated_at">
        Update: Partial<Omit<FortnoxConnection, "id" | "connected_at" | "updated_at">>
      }
      audit_log: {
        Row: AuditLogEntry
        Insert: Omit<AuditLogEntry, "id" | "created_at">
        Update: never
      }
      invoices: {
        Row: Invoice
        Insert: Omit<Invoice, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Invoice, "id" | "created_at" | "updated_at">>
      }
      invoice_rows: {
        Row: InvoiceRow
        Insert: Omit<InvoiceRow, "id" | "created_at">
        Update: Partial<Omit<InvoiceRow, "id" | "created_at">>
      }
      article_registry: {
        Row: ArticleRegistry
        Insert: Omit<ArticleRegistry, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<ArticleRegistry, "id" | "created_at" | "updated_at">>
      }
      article_group_mappings: {
        Row: ArticleGroupMapping
        Insert: Omit<ArticleGroupMapping, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<ArticleGroupMapping, "id" | "created_at" | "updated_at">>
      }
      cost_centers: {
        Row: CostCenter
        Insert: Omit<CostCenter, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<CostCenter, "id" | "created_at" | "updated_at">>
      }
      time_reports: {
        Row: TimeReport
        Insert: Omit<TimeReport, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<TimeReport, "id" | "created_at" | "updated_at">>
      }
      contract_accruals: {
        Row: ContractAccrual
        Insert: Omit<ContractAccrual, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<ContractAccrual, "id" | "created_at" | "updated_at">>
      }
      customer_contacts: {
        Row: CustomerContact
        Insert: Omit<CustomerContact, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<CustomerContact, "id" | "created_at" | "updated_at">>
      }
      customer_contact_links: {
        Row: CustomerContactLink
        Insert: Omit<CustomerContactLink, "id" | "created_at">
        Update: Partial<Omit<CustomerContactLink, "id" | "created_at">>
      }
      customer_activities: {
        Row: CustomerActivity
        Insert: Omit<CustomerActivity, "id" | "created_at">
        Update: Partial<Omit<CustomerActivity, "id" | "created_at">>
      }
      customer_services: {
        Row: CustomerService
        Insert: Omit<CustomerService, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<CustomerService, "id" | "created_at" | "updated_at">>
      }
      customer_document_links: {
        Row: CustomerDocumentLink
        Insert: Omit<CustomerDocumentLink, "id" | "created_at">
        Update: never
      }
      app_settings: {
        Row: AppSetting
        Insert: AppSetting
        Update: Partial<Omit<AppSetting, "key">>
      }
      license_price_list: {
        Row: LicensePriceListItem
        Insert: Omit<LicensePriceListItem, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<LicensePriceListItem, "id" | "created_at" | "updated_at">>
      }
      license_customer_config: {
        Row: LicenseCustomerConfig
        Insert: Omit<LicenseCustomerConfig, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<LicenseCustomerConfig, "id" | "created_at" | "updated_at">>
      }
      mail_templates: {
        Row: MailTemplate
        Insert: Omit<MailTemplate, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<MailTemplate, "id" | "created_at" | "updated_at">>
      }
      documents: {
        Row: Document
        Insert: Omit<Document, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Document, "id" | "created_at" | "updated_at">>
      }
      document_chunks: {
        Row: DocumentChunk
        Insert: Omit<DocumentChunk, "id" | "created_at">
        Update: Partial<Omit<DocumentChunk, "id" | "created_at">>
      }
      conversations: {
        Row: Conversation
        Insert: Omit<Conversation, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<Conversation, "id" | "created_at" | "updated_at">>
      }
      sent_emails: {
        Row: SentEmail
        Insert: Omit<SentEmail, "id" | "created_at" | "updated_at" | "sent_at"> & {
          sent_at?: string
        }
        Update: Partial<Omit<SentEmail, "id" | "created_at" | "updated_at">>
      }
      mail_send_batches: {
        Row: MailSendBatch
        Insert: Omit<MailSendBatch, "id" | "created_at" | "updated_at" | "sent_at" | "recipient_count" | "sent_count" | "failed_count"> & {
          sent_at?: string
          recipient_count?: number
          sent_count?: number
          failed_count?: number
        }
        Update: Partial<Omit<MailSendBatch, "id" | "created_at" | "updated_at">>
      }
      email_events: {
        Row: EmailEvent
        Insert: Omit<EmailEvent, "id" | "created_at"> & {
          created_at?: string
        }
        Update: never
      }
      sync_jobs: {
        Row: SyncJob
        Insert: Omit<SyncJob, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<SyncJob, "id" | "created_at" | "updated_at">>
      }
      manager_time_kpis: {
        Row: ManagerTimeKpi
        Insert: Omit<ManagerTimeKpi, "id" | "created_at" | "updated_at">
        Update: Partial<Omit<ManagerTimeKpi, "id" | "created_at" | "updated_at">>
      }
    }
  }
}
