"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { type ColumnDef } from "@tanstack/react-table"
import { Users, Tags, Mail, BarChart3, Download } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import type { CustomerWithRelations, Profile, Segment } from "@/types/database"
import { DataTable } from "@/components/app/data-table"
import { ActionBar } from "@/components/app/action-bar"
import {
  CustomerFilters,
  applyFilters,
  EMPTY_FILTERS,
  type CustomerFilterState,
  type CustomerListColumnOption,
} from "@/components/app/customer-filters"
import { SearchInput } from "@/components/app/search-input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { useCachedData } from "@/hooks/use-cached-data"

function getCustomerColumns(
  t: (key: string, fallback?: string) => string,
  onShowOverdueInvoices: (customer: CustomerWithRelations) => void
): ColumnDef<CustomerWithRelations, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      size: 250,
      minSize: 120,
      header: t("customers.table.name", "Name"),
    },
    {
      id: "fortnox_customer_number",
      accessorKey: "fortnox_customer_number",
      size: 150,
      minSize: 100,
      header: t("customers.table.customerNo", "Customer No."),
      cell: ({ row }) => row.getValue("fortnox_customer_number") || "—",
    },
    {
      id: "org_number",
      accessorKey: "org_number",
      size: 140,
      minSize: 100,
      header: t("customers.table.orgNumber", "Org Number"),
      cell: ({ row }) => row.getValue("org_number") || "—",
    },
    {
      id: "contact_name",
      accessorKey: "contact_name",
      size: 180,
      minSize: 100,
      header: t("customers.table.primaryContact", "Primary Contact"),
      cell: ({ row }) => row.getValue("contact_name") || "—",
    },
    {
      id: "email",
      accessorKey: "email",
      size: 220,
      minSize: 100,
      header: t("customers.table.email", "Email"),
      cell: ({ row }) => row.getValue("email") || "—",
    },
    {
      id: "account_manager",
      size: 180,
      minSize: 100,
      header: t("customers.table.customerManager", "Customer Manager"),
      cell: ({ row }) => {
        const manager = row.original.account_manager
        if (!manager) return <span className="text-muted-foreground">—</span>
        return manager.full_name ?? manager.email
      },
    },
    {
      id: "invoice_count",
      accessorKey: "invoice_count",
      size: 120,
      minSize: 100,
      header: t("customers.table.invoices", "Invoices"),
      cell: ({ row }) => formatNumber(row.getValue("invoice_count") as number | null),
    },
    {
      id: "contract_value",
      accessorKey: "contract_value",
      size: 170,
      minSize: 120,
      header: t("customers.table.contractValue", "Contract Value"),
      cell: ({ row }) => formatSek(row.getValue("contract_value") as number | null),
    },
    {
      id: "has_overdue_invoices",
      size: 150,
      minSize: 100,
      header: t("customers.table.overdueInvoices", "Overdue Invoices"),
      cell: ({ row }) =>
        row.original.has_overdue_invoices ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onShowOverdueInvoices(row.original)
            }}
            className="cursor-pointer"
            title={t("customers.table.overdueShowInvoices", "Show overdue invoices")}
          >
            <Badge
              variant="destructive"
              className="text-xs font-normal transition-opacity hover:opacity-80"
            >
              {t("customers.table.overdueBadge", "Overdue")}
            </Badge>
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "segments",
      size: 200,
      minSize: 100,
      header: t("customers.table.segments", "Segments"),
      cell: ({ row }) => {
        const segments = row.original.segments
        if (!segments || segments.length === 0) {
          return <span className="text-muted-foreground">—</span>
        }
        return (
          <div className="flex flex-wrap gap-1">
            {segments.map((segment: Segment) => (
              <Badge
                key={segment.id}
                variant="outline"
                className="text-xs font-normal"
                style={{
                  borderColor: segment.color,
                  color: segment.color,
                }}
              >
                {segment.name}
              </Badge>
            ))}
          </div>
        )
      },
    },
  ]
}

const sekFormatter = new Intl.NumberFormat("sv-SE", {
  style: "currency",
  currency: "SEK",
  maximumFractionDigits: 0,
})

const numberFormatter = new Intl.NumberFormat("sv-SE")

function formatSek(value: number | null): string {
  if (value == null) return "—"
  return sekFormatter.format(value)
}

function formatNumber(value: number | null): string {
  if (value == null) return "—"
  return numberFormatter.format(value)
}

function escapeCsvValue(value: string): string {
  const escaped = value.replace(/"/g, '""')
  return `"${escaped}"`
}

function toCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",")
}

interface OverdueInvoiceRow {
  id: string
  document_number: string
  invoice_date: string | null
  due_date: string | null
  total: number | null
  balance: number | null
  currency_code: string | null
}

function daysOverdue(dueDate: string | null): number | null {
  if (!dueDate) return null
  const due = Date.parse(dueDate)
  if (Number.isNaN(due)) return null
  const today = Date.parse(new Date().toISOString().slice(0, 10))
  return Math.max(0, Math.floor((today - due) / 86400000))
}

function formatInvoiceAmount(value: number | null, currencyCode: string | null): string {
  if (value == null) return "—"
  if (!currencyCode || currencyCode === "SEK") return sekFormatter.format(value)
  return `${numberFormatter.format(value)} ${currencyCode}`
}

interface CustomerListColumnDefinition {
  id: string
  labelKey: string
  fallbackLabel: string
  alwaysVisible?: boolean
}

const customerListColumnDefinitions: CustomerListColumnDefinition[] = [
  { id: "name", labelKey: "customers.columns.customerName", fallbackLabel: "Customer Name", alwaysVisible: true },
  { id: "fortnox_customer_number", labelKey: "customers.columns.customerNo", fallbackLabel: "Customer No." },
  { id: "org_number", labelKey: "customers.columns.orgNumber", fallbackLabel: "Org Number" },
  { id: "contact_name", labelKey: "customers.columns.primaryContact", fallbackLabel: "Primary Contact" },
  { id: "email", labelKey: "customers.columns.email", fallbackLabel: "Email" },
  { id: "account_manager", labelKey: "customers.columns.customerManager", fallbackLabel: "Customer Manager" },
  { id: "invoice_count", labelKey: "customers.columns.invoices", fallbackLabel: "Invoices" },
  { id: "contract_value", labelKey: "customers.columns.contractValue", fallbackLabel: "Contract Value" },
  { id: "has_overdue_invoices", labelKey: "customers.columns.overdueInvoices", fallbackLabel: "Overdue Invoices" },
  { id: "segments", labelKey: "customers.columns.segments", fallbackLabel: "Segments" },
]

const OVERDUE_GRACE_DAYS = 3
const CUSTOMER_FILTERS_STORAGE_KEY = "saldo-crm:customers:filters"
const CUSTOMER_LIST_COLUMNS_STORAGE_KEY = "saldo-crm:customers:list-columns"
const CUSTOMER_TABLE_PAGE_SIZE = 15
const DEFAULT_VISIBLE_LIST_COLUMN_IDS = new Set<string>([
  "name",
  "fortnox_customer_number",
  "account_manager",
  "has_overdue_invoices",
  "segments",
])

function getDefaultVisibleListColumns(): Record<string, boolean> {
  return Object.fromEntries(
    customerListColumnDefinitions.map((column) => [
      column.id,
      column.alwaysVisible || DEFAULT_VISIBLE_LIST_COLUMN_IDS.has(column.id),
    ])
  )
}

function isCustomerFilterState(value: unknown): value is CustomerFilterState {
  if (!value || typeof value !== "object") return false

  const candidate = value as Record<string, unknown>

  return (
    Array.isArray(candidate.statuses) &&
    Array.isArray(candidate.segmentIds) &&
    Array.isArray(candidate.managerIds) &&
    typeof candidate.missingPrimaryContact === "boolean" &&
    typeof candidate.missingEmail === "boolean" &&
    typeof candidate.missingCustomerManager === "boolean" &&
    (candidate.missingBokslutSetup === undefined ||
      typeof candidate.missingBokslutSetup === "boolean") &&
    (candidate.hasOverdueInvoices === undefined ||
      typeof candidate.hasOverdueInvoices === "boolean")
  )
}

export default function CustomersPage() {
  const router = useRouter()
  const { t } = useTranslation()
  const { user } = useUser()

  const fetchCustomers = React.useCallback(async (): Promise<CustomerWithRelations[]> => {
    const supabase = createClient()

    const PAGE_SIZE = 1000
    let allRows: CustomerWithRelations[] = []
    let from = 0
    let hasMore = true

    while (hasMore) {
      const { data } = await supabase
        .from("customers")
        .select("*")
        .order("name")
        .range(from, from + PAGE_SIZE - 1)

      const rows = (data ?? []) as unknown as CustomerWithRelations[]
      allRows = allRows.concat(rows)
      hasMore = rows.length === PAGE_SIZE
      from += PAGE_SIZE
    }

    const { data: profileRows } = await supabase
      .from("profiles")
      .select("id, full_name, email, fortnox_cost_center")
      .eq("is_active", true)
      .not("fortnox_cost_center", "is", null)

    const profileByCostCenter = new Map<string, Pick<Profile, "id" | "full_name" | "email">>()
    for (const p of (profileRows ?? []) as unknown as { id: string; full_name: string | null; email: string; fortnox_cost_center: string }[]) {
      profileByCostCenter.set(p.fortnox_cost_center, { id: p.id, full_name: p.full_name, email: p.email })
    }

    const customerIds = allRows.map((c) => c.id)

    const segmentMap: Record<string, Segment[]> = {}

    const BATCH = 200
    for (let i = 0; i < customerIds.length; i += BATCH) {
      const batch = customerIds.slice(i, i + BATCH)

      const { data: csRows } = await supabase
        .from("customer_segments")
        .select("customer_id, segment:segments(*)")
        .in("customer_id", batch)

      const rawCs = (csRows ?? []) as unknown as {
        customer_id: string
        segment: Segment
      }[]

      for (const row of rawCs) {
        if (!segmentMap[row.customer_id]) segmentMap[row.customer_id] = []
        segmentMap[row.customer_id].push(row.segment)
      }
    }

    // Customers with invoices that are unpaid (balance > 0) and overdue by
    // more than OVERDUE_GRACE_DAYS days past the due date (due_date — same
    // column the reports overdue KPI uses; final_pay_date is the date an
    // invoice was fully paid, so it is NULL on unpaid invoices).
    const overdueCutoff = new Date()
    overdueCutoff.setDate(overdueCutoff.getDate() - OVERDUE_GRACE_DAYS)
    const overdueCutoffIso = overdueCutoff.toISOString().slice(0, 10)

    const overdueCustomerIds = new Set<string>()
    const overdueCustomerNumbers = new Set<string>()
    let invoiceFrom = 0
    let invoiceHasMore = true

    while (invoiceHasMore) {
      const { data: invoiceRows } = await supabase
        .from("invoices")
        .select("customer_id, fortnox_customer_number")
        .gt("balance", 0)
        .lt("due_date", overdueCutoffIso)
        .range(invoiceFrom, invoiceFrom + PAGE_SIZE - 1)

      const rows = (invoiceRows ?? []) as unknown as {
        customer_id: string | null
        fortnox_customer_number: string | null
      }[]
      for (const row of rows) {
        if (row.customer_id) overdueCustomerIds.add(row.customer_id)
        if (row.fortnox_customer_number) overdueCustomerNumbers.add(row.fortnox_customer_number)
      }
      invoiceHasMore = rows.length === PAGE_SIZE
      invoiceFrom += PAGE_SIZE
    }

    return allRows.map((c) => ({
      ...c,
      account_manager: c.fortnox_cost_center ? profileByCostCenter.get(c.fortnox_cost_center) ?? null : null,
      segments: segmentMap[c.id] ?? [],
      has_overdue_invoices:
        overdueCustomerIds.has(c.id) ||
        (c.fortnox_customer_number != null &&
          overdueCustomerNumbers.has(c.fortnox_customer_number)),
    }))
  }, [])

  const {
    data: cachedCustomers,
    loading,
    refresh: refreshCustomers,
  } = useCachedData<CustomerWithRelations[]>({
    key: `customers.v3.${user.id}`,
    fetcher: fetchCustomers,
    staleMs: 120000,
  })

  const customers = React.useMemo(
    () => cachedCustomers ?? [],
    [cachedCustomers],
  )

  const [selectedCustomers, setSelectedCustomers] = React.useState<CustomerWithRelations[]>([])
  const [segmentsDialogOpen, setSegmentsDialogOpen] = React.useState(false)
  const [allSegments, setAllSegments] = React.useState<Segment[]>([])
  const [checkedSegmentIds, setCheckedSegmentIds] = React.useState<Set<string>>(new Set())
  const [assigning, setAssigning] = React.useState(false)
  const clearSelectionRef = React.useRef<(() => void) | null>(null)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [filters, setFilters] = React.useState<CustomerFilterState>(EMPTY_FILTERS)
  const [overdueDialogCustomer, setOverdueDialogCustomer] = React.useState<CustomerWithRelations | null>(null)
  const [overdueInvoiceRows, setOverdueInvoiceRows] = React.useState<OverdueInvoiceRow[]>([])
  const [overdueInvoicesLoading, setOverdueInvoicesLoading] = React.useState(false)
  const [visibleListColumns, setVisibleListColumns] = React.useState<Record<string, boolean>>(() => getDefaultVisibleListColumns())

  const handleShowOverdueInvoices = React.useCallback(
    async (customer: CustomerWithRelations) => {
      setOverdueDialogCustomer(customer)
      setOverdueInvoiceRows([])
      setOverdueInvoicesLoading(true)

      const supabase = createClient()
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - OVERDUE_GRACE_DAYS)
      const cutoffIso = cutoff.toISOString().slice(0, 10)

      let query = supabase
        .from("invoices")
        .select("id, document_number, invoice_date, due_date, total, balance, currency_code")
        .gt("balance", 0)
        .lt("due_date", cutoffIso)
        .order("due_date", { ascending: true })

      query = customer.fortnox_customer_number
        ? query.or(
            `customer_id.eq.${customer.id},fortnox_customer_number.eq.${customer.fortnox_customer_number}`
          )
        : query.eq("customer_id", customer.id)

      const { data, error } = await query

      if (error) {
        toast.error(t("customers.dialog.overdue.loadFailed", "Failed to load overdue invoices"))
        setOverdueInvoiceRows([])
      } else {
        setOverdueInvoiceRows((data ?? []) as unknown as OverdueInvoiceRow[])
      }
      setOverdueInvoicesLoading(false)
    },
    [t]
  )

  const columns = React.useMemo(
    () => getCustomerColumns(t, handleShowOverdueInvoices),
    [t, handleShowOverdueInvoices]
  )

  const listColumns = React.useMemo<CustomerListColumnOption[]>(
    () =>
      customerListColumnDefinitions.map((column) => ({
        id: column.id,
        label: t(column.labelKey, column.fallbackLabel),
        alwaysVisible: column.alwaysVisible,
        visible: visibleListColumns[column.id] ?? true,
      })),
    [t, visibleListColumns]
  )

  const visibleColumns = React.useMemo(
    () => columns.filter((column) => visibleListColumns[column.id ?? ""] ?? true),
    [columns, visibleListColumns]
  )

  const filteredCustomers = React.useMemo(() => {
    let result = customers

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.fortnox_customer_number?.toLowerCase().includes(q) ||
          c.org_number?.toLowerCase().includes(q) ||
          c.contact_name?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q)
      )
    }

    return applyFilters(result, filters)
  }, [customers, searchQuery, filters])

  const hasNonDefaultFilters =
    !(filters.statuses.length === 1 && filters.statuses[0] === "active") ||
    filters.segmentIds.length > 0 ||
    filters.managerIds.length > 0 ||
    filters.missingPrimaryContact ||
    filters.missingEmail ||
    filters.missingCustomerManager ||
    filters.missingBokslutSetup ||
    filters.hasOverdueInvoices

  const hasSearch = searchQuery.trim().length > 0
  const hasFilterResultGap = customers.length > 0 && filteredCustomers.length === 0 && (hasNonDefaultFilters || hasSearch)

  const emptyState = hasFilterResultGap
    ? {
        icon: Users,
        title: t("customers.empty.title", "No customers"),
        description: t("customers.filters.subtitle", "Refine the customer list and choose what is shown in the list."),
        action: {
          label: t("customers.filters.clearAll", "Clear all filters"),
          onClick: () => {
            setFilters(EMPTY_FILTERS)
            setSearchQuery("")
          },
        },
      }
    : {
        icon: Users,
        title: t("customers.empty.title", "No customers"),
        description: t(
          "customers.empty.description",
          "Connect Fortnox in Settings → Integrations to sync your customer database."
        ),
        action: {
          label: t("customers.empty.goToIntegrations", "Go to Integrations"),
          onClick: () => router.push("/settings/integrations"),
        },
      }

  React.useEffect(() => {
    try {
      const storedColumns = window.localStorage.getItem(CUSTOMER_LIST_COLUMNS_STORAGE_KEY)
      if (!storedColumns) return

      const parsedColumns = JSON.parse(storedColumns) as unknown
      if (!parsedColumns || typeof parsedColumns !== "object") return

      const candidate = parsedColumns as Record<string, unknown>
      const next = getDefaultVisibleListColumns()
      for (const column of customerListColumnDefinitions) {
        if (typeof candidate[column.id] === "boolean") {
          next[column.id] = column.alwaysVisible ? true : candidate[column.id] as boolean
        }
      }
      setVisibleListColumns(next)
    } catch {
      window.localStorage.removeItem(CUSTOMER_LIST_COLUMNS_STORAGE_KEY)
    }
  }, [])

  React.useEffect(() => {
    try {
      const storedFilters = window.localStorage.getItem(CUSTOMER_FILTERS_STORAGE_KEY)
      if (!storedFilters) return

      const parsedFilters = JSON.parse(storedFilters) as unknown
      if (isCustomerFilterState(parsedFilters)) {
        setFilters({ ...EMPTY_FILTERS, ...parsedFilters })
      }
    } catch {
      window.localStorage.removeItem(CUSTOMER_FILTERS_STORAGE_KEY)
    }
  }, [])

  function handleOpenSegmentsDialog() {
    const supabase = createClient()
    supabase
      .from("segments")
      .select("*")
      .order("name")
      .then(({ data }) => {
        setAllSegments((data ?? []) as unknown as Segment[])
        setCheckedSegmentIds(new Set())
        setSegmentsDialogOpen(true)
      })
  }

  function toggleSegment(segmentId: string) {
    setCheckedSegmentIds((prev) => {
      const next = new Set(prev)
      if (next.has(segmentId)) {
        next.delete(segmentId)
      } else {
        next.add(segmentId)
      }
      return next
    })
  }

  async function handleAssignSegments() {
    if (checkedSegmentIds.size === 0) return
    setAssigning(true)

    const supabase = createClient()
    const rows = selectedCustomers.flatMap((customer) =>
      Array.from(checkedSegmentIds).map((segmentId) => ({
        customer_id: customer.id,
        segment_id: segmentId,
      }))
    )

    const { error } = await supabase
      .from("customer_segments")
      .upsert(rows as never[], { onConflict: "customer_id,segment_id" })

    if (error) {
      toast.error(t("customers.toast.assignSegmentsFailed", "Failed to assign segments"))
    } else {
      toast.success(
        selectedCustomers.length === 1
          ? t("customers.toast.assignSegmentsSuccessOne", "Segment assigned to 1 customer")
          : t("customers.toast.assignSegmentsSuccessMany", "Segments assigned to selected customers")
      )
      setSegmentsDialogOpen(false)
      clearSelectionRef.current?.()
      void refreshCustomers()
    }

    setAssigning(false)
  }

  function handleClearSelection() {
    clearSelectionRef.current?.()
  }

  function handleSendMail() {
    const customerIds = selectedCustomers.map((customer) => customer.id)
    if (customerIds.length === 0) return
    router.push(`/mail?customerIds=${encodeURIComponent(customerIds.join(","))}`)
  }

  function handleOpenInReports() {
    const selectedCustomer = selectedCustomers[0]
    if (!selectedCustomer) return
    router.push(`/reports?customerId=${encodeURIComponent(selectedCustomer.id)}`)
  }

  function toggleListColumn(columnId: string) {
    const column = customerListColumnDefinitions.find((item) => item.id === columnId)
    if (column?.alwaysVisible) return

    setVisibleListColumns((prev) => ({
      ...prev,
      [columnId]: !(prev[columnId] ?? true),
    }))
  }

  function resetListColumns() {
    setVisibleListColumns(getDefaultVisibleListColumns())
  }

  function handleSaveFilter() {
    window.localStorage.setItem(CUSTOMER_FILTERS_STORAGE_KEY, JSON.stringify(filters))
    window.localStorage.setItem(CUSTOMER_LIST_COLUMNS_STORAGE_KEY, JSON.stringify(visibleListColumns))
    toast.success(t("customers.toast.filtersSaved", "Filters and list fields saved"))
  }

  function handleExportCsv() {
    if (filteredCustomers.length === 0) {
      toast.error(t("customers.export.none", "No customers to export"))
      return
    }

    const exportColumns = customerListColumnDefinitions.filter(
      (column) => visibleListColumns[column.id] ?? true,
    )

    const headers = exportColumns.map((column) => t(column.labelKey, column.fallbackLabel))

    const rows = filteredCustomers.map((customer) =>
      exportColumns.map((column) => {
        switch (column.id) {
          case "name":
            return customer.name ?? ""
          case "fortnox_customer_number":
            return customer.fortnox_customer_number ?? ""
          case "org_number":
            return customer.org_number ?? ""
          case "contact_name":
            return customer.contact_name ?? ""
          case "email":
            return customer.email ?? ""
          case "account_manager":
            return customer.account_manager
              ? customer.account_manager.full_name ?? customer.account_manager.email
              : ""
          case "invoice_count":
            return customer.invoice_count == null ? "" : String(customer.invoice_count)
          case "contract_value":
            return customer.contract_value == null ? "" : String(customer.contract_value)
          case "has_overdue_invoices":
            return customer.has_overdue_invoices
              ? t("customers.table.overdueBadge", "Overdue")
              : ""
          case "segments":
            return (customer.segments ?? []).map((segment) => segment.name).join(" | ")
          default:
            return ""
        }
      }),
    )

    const csvContent = [toCsvRow(headers), ...rows.map(toCsvRow)].join("\n")
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const timestamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement("a")

    link.href = url
    link.download = `customers-${timestamp}.csv`
    link.click()
    URL.revokeObjectURL(url)

    toast.success(t("customers.export.success", "Customer CSV exported"))
  }

  const toolbar = (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t("customers.searchPlaceholder", "Search customers...")}
        className="w-full lg:max-w-sm"
      />
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleExportCsv} disabled={loading || filteredCustomers.length === 0}>
          <Download className="size-3.5" />
          {t("customers.export.csv", "Export CSV")}
        </Button>
        <CustomerFilters
          customers={customers}
          filters={filters}
          onFiltersChange={setFilters}
          onSaveFilter={handleSaveFilter}
          listColumns={listColumns}
          onToggleListColumn={toggleListColumn}
          onResetListColumns={resetListColumns}
        />
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {toolbar}

      <DataTable
        columns={visibleColumns}
        data={filteredCustomers}
        loading={loading}
        pageSize={CUSTOMER_TABLE_PAGE_SIZE}
        pageSizeOptions={[15, 30, 50]}
        getRowId={(customer) => customer.id}
        selectable
        selectAllRows
        onSelectionChange={setSelectedCustomers}
        clearSelectionRef={clearSelectionRef}
        onRowNavigate={(customer) => router.push(`/customers/${customer.id}`)}
        emptyState={emptyState}
      />

      <ActionBar
        selectedCount={selectedCustomers.length}
        onClear={handleClearSelection}
        actions={[
          ...(selectedCustomers.length === 1
            ? [
                {
                  label: t("customers.actions.openInReports", "Open in Reports"),
                  icon: BarChart3,
                  onClick: handleOpenInReports,
                  variant: "outline" as const,
                },
              ]
            : []),
          {
            label: t("customers.actions.sendMail", "Send Mail"),
            icon: Mail,
            onClick: handleSendMail,
          },
          {
            label: t("customers.actions.addSegments", "Add Segments"),
            icon: Tags,
            onClick: handleOpenSegmentsDialog,
          },
        ]}
      />

      <Dialog
        open={overdueDialogCustomer !== null}
        onOpenChange={(open) => {
          if (!open) setOverdueDialogCustomer(null)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("customers.dialog.overdue.title", "Overdue Invoices")}
              {overdueDialogCustomer ? ` — ${overdueDialogCustomer.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              {t(
                "customers.dialog.overdue.description",
                "Unpaid invoices overdue by more than 3 days."
              )}
            </DialogDescription>
          </DialogHeader>
          {overdueInvoicesLoading ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t("customers.dialog.overdue.loading", "Loading invoices...")}
            </p>
          ) : overdueInvoiceRows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t("customers.dialog.overdue.none", "No overdue invoices found.")}
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">
                      {t("customers.dialog.overdue.invoiceNo", "Invoice No.")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {t("customers.dialog.overdue.invoiceDate", "Invoice Date")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {t("customers.dialog.overdue.dueDate", "Due Date")}
                    </th>
                    <th className="pb-2 pr-4 text-right font-medium">
                      {t("customers.dialog.overdue.daysOverdue", "Days Overdue")}
                    </th>
                    <th className="pb-2 text-right font-medium">
                      {t("customers.dialog.overdue.balance", "Balance")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overdueInvoiceRows.map((invoice) => {
                    const overdueDays = daysOverdue(invoice.due_date)
                    return (
                      <tr key={invoice.id} className="border-b last:border-b-0">
                        <td className="py-2 pr-4 font-medium">{invoice.document_number}</td>
                        <td className="py-2 pr-4">{invoice.invoice_date ?? "—"}</td>
                        <td className="py-2 pr-4">{invoice.due_date ?? "—"}</td>
                        <td className="py-2 pr-4 text-right">
                          {overdueDays == null ? (
                            "—"
                          ) : (
                            <span className="font-medium text-destructive">{overdueDays}</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          {formatInvoiceAmount(invoice.balance, invoice.currency_code)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!overdueInvoicesLoading && overdueInvoiceRows.length > 0 ? (
            <div className="flex items-center justify-between border-t pt-3 text-sm">
              <span className="text-muted-foreground">
                {overdueInvoiceRows.length}{" "}
                {overdueInvoiceRows.length === 1
                  ? t("customers.dialog.overdue.invoiceSingular", "invoice")
                  : t("customers.dialog.overdue.invoicePlural", "invoices")}
              </span>
              <span className="font-medium">
                {t("customers.dialog.overdue.total", "Total")}:{" "}
                {formatInvoiceAmount(
                  overdueInvoiceRows.reduce((sum, invoice) => sum + (invoice.balance ?? 0), 0),
                  overdueInvoiceRows[0]?.currency_code ?? "SEK"
                )}
              </span>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={segmentsDialogOpen} onOpenChange={setSegmentsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("customers.dialog.addSegments.title", "Add Segments")}</DialogTitle>
            <DialogDescription>
              {t(
                "customers.dialog.addSegments.description",
                "Select segments to assign to selected customers."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {allSegments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t(
                  "customers.dialog.addSegments.noneAvailable",
                  "No segments available. Create segments in Settings → Segments."
                )}
              </p>
            ) : (
              <div className="space-y-2">
                {allSegments.map((segment) => (
                  <label
                    key={segment.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={checkedSegmentIds.has(segment.id)}
                      onCheckedChange={() => toggleSegment(segment.id)}
                    />
                    <Badge
                      variant="outline"
                      className="text-xs font-normal"
                      style={{
                        borderColor: segment.color,
                        color: segment.color,
                      }}
                    >
                      {segment.name}
                    </Badge>
                    {segment.description && (
                      <span className="text-sm text-muted-foreground">
                        {segment.description}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setSegmentsDialogOpen(false)}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                onClick={handleAssignSegments}
                disabled={checkedSegmentIds.size === 0 || assigning}
              >
                {assigning
                  ? t("customers.dialog.addSegments.assigning", "Assigning...")
                  : t("customers.dialog.addSegments.assign", "Assign Segments")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
