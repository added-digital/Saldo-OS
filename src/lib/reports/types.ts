import type { Profile, Team } from "@/types/database";

export type RollingMonth = {
  key: string;
  label: string;
  year: number;
  month: number;
};

export type ReportingWindowMode =
  | "current-month"
  | "rolling-12-months"
  | "rolling-year";

export type ComparisonMode = "year-over-year" | "period-over-period" | "none";

export type SavedReportsFilters = {
  selectedMonth: string | null;
  selectedWindowMode: ReportingWindowMode | null;
  selectedTeamId: string | null;
  selectedManagerId: string | null;
  selectedCustomerId: string | null;
  comparisonMode: ComparisonMode | null;
  // Controls whether rolling-window modes (rolling-12-months / rolling-year)
  // include the current, in-progress month or end at the last completed
  // month. Only meaningful for those two modes; current-month mode ignores
  // it. `null` means "not persisted yet" — callers should default to true
  // (include) when loading.
  includeCurrentMonth: boolean | null;
};

export type TeamOption = Pick<Team, "id" | "name">;

export type ManagerOption = Pick<
  Profile,
  | "id"
  | "full_name"
  | "email"
  | "team_id"
  | "fortnox_cost_center"
  | "fortnox_employee_id"
  | "fortnox_user_id"
  | "fortnox_group_name"
>;

export type SelectOption = {
  id: string;
  label: string;
  subLabel?: string;
  showAvatar?: boolean;
  avatarFallback?: string;
};

export type SearchSelectProps = {
  placeholder: string;
  searchPlaceholder: string;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  allLabel?: string;
  allowClear?: boolean;
  noOptionsLabel?: string;
};

export type MonthlyTimeReportingRow = {
  monthKey: string;
  monthLabel: string;
  customerHours: number;
  absenceHours: number;
  internalHours: number;
  totalHours: number;
};

export type CustomerTimeReportingRow = {
  contributorKey: string;
  managerProfileId: string | null;
  contributorId: string | null;
  contributorName: string;
  groupName: string;
  customerHours: number;
  workloadPercentage: number;
};

export type HelpedCustomerManagerRow = {
  managerProfileId: string;
  managerName: string;
  groupName: string;
  customerHours: number;
  workloadPercentage: number;
};

export type CustomerMonthlyEconomicsRow = {
  monthKey: string;
  monthLabel: string;
  turnover: number | null;
  turnoverFromTotal: boolean;
  hours: number;
  turnoverPerHour: number | null;
};

export type ManagerCustomerSummaryRow = {
  customerId: string;
  customerName: string;
  turnover: number;
  invoiceCount: number;
  contractValue: number;
  workloadPercentage: number;
  customerHours: number;
};

export type ArticleGroupItemRow = {
  articleNumber: string | null;
  articleName: string;
  turnoverExVat: number;
  rowCount: number;
  quantity: number;
  shareOfGroup: number;
  invoiceNumbers: string[];
};

export type ArticleGroupSummaryRow = {
  groupName: string;
  turnoverExVat: number;
  articleCount: number;
  rowCount: number;
  quantity: number;
  shareOfTotal: number;
  articles: ArticleGroupItemRow[];
};

export type TurnoverMonthRow = {
  monthKey: string;
  monthLabel: string;
  turnover: number;
  invoiceCount: number;
};

export type MonthlyInvoiceGroupRow = {
  monthKey: string;
  groupValue: string;
  turnover: number;
};

export type MonthlyHourGroupRow = {
  monthKey: string;
  groupValue: string;
  hours: number;
};

export type TimeDetailMetric =
  | "customerHours"
  | "absenceHours"
  | "internalHours"
  | "otherHours"
  | "totalHours";

export type TimeDetailRow = {
  id: string;
  reportDate: string | null;
  customerName: string | null;
  employeeName: string | null;
  entryType: string | null;
  projectName: string | null;
  activity: string | null;
  description: string | null;
  hours: number;
};

export type InvoiceDetailRow = {
  id: string;
  documentNumber: string;
  customerName?: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  turnover: number | null;
  turnoverFromTotal: boolean;
  currencyCode: string;
  status?: "paid" | "pending" | "overdue";
};

export type InvoiceDetailSource = {
  id: string;
  document_number: string | null;
  customer_name?: string | null;
  invoice_date: string | null;
  due_date?: string | null;
  total_ex_vat: number | null;
  total: number | null;
  currency_code: string | null;
  balance?: number | null;
};

export type TurnoverTooltipPayloadItem = {
  value?: number | string | null;
  dataKey?: string;
  payload?: {
    invoiceCount?: number;
    previousTurnover?: number;
    previousInvoiceCount?: number;
    previousMonthLabel?: string | null;
  };
};
