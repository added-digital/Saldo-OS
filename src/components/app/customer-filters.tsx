"use client"

import * as React from "react"
import { ChevronDown, Filter } from "lucide-react"

import type { CustomerWithRelations, Profile, Segment } from "@/types/database"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { SearchInput } from "@/components/app/search-input"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTranslation } from "@/hooks/use-translation"

type CustomerStatusFilter = "active" | "archived"

interface CustomerFilterState {
  statuses: CustomerStatusFilter[]
  segmentIds: string[]
  managerIds: string[]
  missingPrimaryContact: boolean
  missingEmail: boolean
  missingCustomerManager: boolean
  hasOverdueInvoices: boolean
}

interface CustomerListColumnOption {
  id: string
  label: string
  visible: boolean
  alwaysVisible?: boolean
}

const EMPTY_FILTERS: CustomerFilterState = {
  statuses: ["active"],
  segmentIds: [],
  managerIds: [],
  missingPrimaryContact: false,
  missingEmail: false,
  missingCustomerManager: false,
  hasOverdueInvoices: false,
}

function hasActiveFilters(filters: CustomerFilterState): boolean {
  const isDefaultStatus =
    filters.statuses.length === 1 && filters.statuses[0] === "active"
  return (
    (!isDefaultStatus && filters.statuses.length > 0) ||
    filters.segmentIds.length > 0 ||
    filters.managerIds.length > 0 ||
    filters.missingPrimaryContact ||
    filters.missingEmail ||
    filters.missingCustomerManager ||
    filters.hasOverdueInvoices
  )
}

function applyFilters(
  customers: CustomerWithRelations[],
  filters: CustomerFilterState
): CustomerWithRelations[] {
  return customers.filter((c) => {
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(c.status as CustomerStatusFilter)
    ) {
      return false
    }

    if (filters.segmentIds.length > 0) {
      const customerSegmentIds = (c.segments ?? []).map((s) => s.id)
      if (!filters.segmentIds.some((id) => customerSegmentIds.includes(id))) {
        return false
      }
    }

    if (filters.managerIds.length > 0) {
      if (!c.account_manager || !filters.managerIds.includes(c.account_manager.id)) {
        return false
      }
    }

    if (filters.missingPrimaryContact && Boolean(c.contact_name?.trim())) {
      return false
    }

    if (filters.missingEmail && Boolean(c.email?.trim())) {
      return false
    }

    if (filters.missingCustomerManager && Boolean(c.account_manager)) {
      return false
    }

    if (filters.hasOverdueInvoices && !c.has_overdue_invoices) {
      return false
    }

    return true
  })
}

interface FilterSectionProps {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
}

function FilterSection({
  title,
  count,
  defaultOpen = false,
  children,
}: FilterSectionProps) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b last:border-b-0">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 w-full justify-between rounded-none px-4 font-medium hover:bg-muted/50"
        >
          <div className="flex items-center gap-2">
            <span>{title}</span>
            {count ? (
              <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[11px]">
                {count}
              </Badge>
            ) : null}
          </div>
          <ChevronDown className="size-4 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface CustomerFiltersProps {
  customers: CustomerWithRelations[]
  filters: CustomerFilterState
  onFiltersChange: (filters: CustomerFilterState) => void
  onSaveFilter?: () => void
  listColumns?: CustomerListColumnOption[]
  onToggleListColumn?: (columnId: string) => void
  onResetListColumns?: () => void
}

function CustomerFilters({
  customers,
  filters,
  onFiltersChange,
  onSaveFilter,
  listColumns,
  onToggleListColumn,
}: CustomerFiltersProps) {
  const { t } = useTranslation()
  const [managerQuery, setManagerQuery] = React.useState("")

  const statusOptions = React.useMemo(
    () => [
      {
        value: "active" as const,
        label: t("customers.filters.status.active", "Active"),
      },
      {
        value: "archived" as const,
        label: t("customers.filters.status.archived", "Archived"),
      },
    ],
    [t]
  )

  const segments = React.useMemo(() => {
    const map = new Map<string, Segment>()
    for (const c of customers) {
      for (const s of c.segments ?? []) {
        if (!map.has(s.id)) map.set(s.id, s)
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [customers])

  const managers = React.useMemo(() => {
    const map = new Map<string, Pick<Profile, "id" | "full_name" | "email">>()
    for (const c of customers) {
      if (c.account_manager && !map.has(c.account_manager.id)) {
        map.set(c.account_manager.id, c.account_manager)
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email)
    )
  }, [customers])

  const overdueCustomerCount = React.useMemo(
    () => customers.filter((c) => c.has_overdue_invoices).length,
    [customers]
  )

  const visibleManagers = React.useMemo(() => {
    if (!managerQuery) return managers

    const query = managerQuery.toLowerCase()
    return managers.filter((manager) =>
      (manager.full_name ?? manager.email).toLowerCase().includes(query)
    )
  }, [managerQuery, managers])

  const isDefaultStatus =
    filters.statuses.length === 1 && filters.statuses[0] === "active"
  const activeCount =
    (isDefaultStatus ? 0 : filters.statuses.length) +
    filters.segmentIds.length +
    filters.managerIds.length +
    (filters.missingPrimaryContact ? 1 : 0) +
    (filters.missingEmail ? 1 : 0) +
    (filters.missingCustomerManager ? 1 : 0) +
    (filters.hasOverdueInvoices ? 1 : 0)

  const missingFieldsCount = [
    filters.missingPrimaryContact,
    filters.missingEmail,
    filters.missingCustomerManager,
  ].filter(Boolean).length

  function toggleStatus(status: CustomerStatusFilter) {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status]
    onFiltersChange({ ...filters, statuses: next })
  }

  function toggleSegment(segmentId: string) {
    const next = filters.segmentIds.includes(segmentId)
      ? filters.segmentIds.filter((id) => id !== segmentId)
      : [...filters.segmentIds, segmentId]
    onFiltersChange({ ...filters, segmentIds: next })
  }

  function toggleManager(managerId: string) {
    const next = filters.managerIds.includes(managerId)
      ? filters.managerIds.filter((id) => id !== managerId)
      : [...filters.managerIds, managerId]
    onFiltersChange({ ...filters, managerIds: next })
    setManagerQuery("")
  }

  function toggleFlag(
    key: "missingPrimaryContact" | "missingEmail" | "missingCustomerManager"
  ) {
    onFiltersChange({ ...filters, [key]: !filters[key] })
  }

  function clearAll() {
    onFiltersChange(EMPTY_FILTERS)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5">
          <Filter className="size-3.5" />
          {t("customers.filters.button", "Filters")}
          {activeCount > 0 ? (
            <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 px-1 text-xs">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("customers.filters.title", "Filters")}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              "customers.filters.subtitle",
              "Refine the customer list and choose what is shown in the list."
            )}
          </p>
        </div>

        <div>
          <FilterSection
            title={t("customers.filters.section.status", "Status")}
            count={filters.statuses.length}
          >
            <div className="space-y-2">
              {statusOptions.map((option) => {
                const checked = filters.statuses.includes(option.value)
                const id = `customer-filter-status-${option.value}`

                return (
                  <label
                    key={option.value}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() => toggleStatus(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                )
              })}
            </div>
          </FilterSection>

          <FilterSection
            title={t("customers.filters.section.segments", "Segments")}
            count={filters.segmentIds.length}
          >
            {segments.length > 0 ? (
              <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {segments.map((segment) => {
                  const checked = filters.segmentIds.includes(segment.id)
                  const id = `customer-filter-segment-${segment.id}`

                  return (
                    <label
                      key={segment.id}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={() => toggleSegment(segment.id)}
                      />
                      <Badge
                        variant="outline"
                        className="text-xs font-normal"
                        style={{ borderColor: segment.color, color: segment.color }}
                      >
                        {segment.name}
                      </Badge>
                    </label>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("customers.filters.noSegments", "No segments available.")}
              </p>
            )}
          </FilterSection>

          <FilterSection
            title={t("customers.filters.section.customerManager", "Customer Manager")}
            count={filters.managerIds.length}
          >
            {managers.length > 0 ? (
              <div className="space-y-3">
                <SearchInput
                  value={managerQuery}
                  onChange={setManagerQuery}
                  placeholder={t("customers.filters.searchManagers", "Search managers...")}
                  className="w-full"
                />
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                  {visibleManagers.map((manager) => {
                  const checked = filters.managerIds.includes(manager.id)
                  const id = `customer-filter-manager-${manager.id}`

                  return (
                    <label
                      key={manager.id}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={() => toggleManager(manager.id)}
                      />
                      <span className="truncate">{manager.full_name ?? manager.email}</span>
                    </label>
                  )
                  })}
                  {visibleManagers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("customers.filters.noManagersMatch", "No managers match your search.")}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("customers.filters.noManagersAvailable", "No customer managers available.")}
              </p>
            )}
          </FilterSection>

          <FilterSection
            title={t("customers.filters.section.invoices", "Invoices")}
            count={filters.hasOverdueInvoices ? 1 : 0}
          >
            <label
              htmlFor="customer-filter-has-overdue-invoices"
              className="flex cursor-pointer items-center gap-3 text-sm"
            >
              <Checkbox
                id="customer-filter-has-overdue-invoices"
                checked={filters.hasOverdueInvoices}
                onCheckedChange={() =>
                  onFiltersChange({
                    ...filters,
                    hasOverdueInvoices: !filters.hasOverdueInvoices,
                  })
                }
              />
              <span>
                {t(
                  "customers.filters.field.hasOverdueInvoices",
                  "Has overdue invoices (3+ days)"
                )}
              </span>
              {overdueCustomerCount > 0 ? (
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[11px]">
                  {overdueCustomerCount}
                </Badge>
              ) : null}
            </label>
          </FilterSection>

          <FilterSection
            title={t("customers.filters.section.missingFields", "Missing fields")}
            count={missingFieldsCount}
            defaultOpen
          >
            <div className="space-y-2">
              {[
                {
                  key: "missingPrimaryContact",
                  label: t("customers.filters.field.primaryContact", "Primary Contact"),
                },
                {
                  key: "missingEmail",
                  label: t("customers.filters.field.email", "Email"),
                },
                {
                  key: "missingCustomerManager",
                  label: t("customers.filters.field.customerManager", "Customer Manager"),
                },
              ].map((item) => {
                const id = `customer-filter-${item.key}`
                const checked = filters[item.key as keyof CustomerFilterState] as boolean

                return (
                  <label
                    key={item.key}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() =>
                        toggleFlag(
                          item.key as
                            | "missingPrimaryContact"
                            | "missingEmail"
                            | "missingCustomerManager"
                        )
                      }
                    />
                    <span>{item.label}</span>
                  </label>
                )
              })}
            </div>
          </FilterSection>

          {listColumns && onToggleListColumn ? (
            <FilterSection
              title={t("customers.filters.section.shownInList", "Shown in list")}
              count={listColumns.filter((column) => column.visible).length}
            >
              <div className="space-y-2">
                {listColumns.map((column) => {
                  const id = `customer-list-column-${column.id}`

                  return (
                    <label
                      key={column.id}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-3 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={column.visible}
                        disabled={column.alwaysVisible}
                        onCheckedChange={() => onToggleListColumn(column.id)}
                      />
                      <span className={cn(column.alwaysVisible && "text-muted-foreground")}>
                        {column.label}
                        {column.alwaysVisible
                          ? ` (${t("customers.filters.alwaysShown", "always shown")})`
                          : ""}
                      </span>
                    </label>
                  )
                })}
              </div>
            </FilterSection>
          ) : null}
        </div>

        <div className="border-t px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-0 text-xs text-muted-foreground"
              onClick={clearAll}
              disabled={!hasActiveFilters(filters)}
            >
              {t("customers.filters.clearAll", "Clear all filters")}
            </Button>
            {onSaveFilter ? (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onSaveFilter}>
                {t("customers.filters.save", "Save filter")}
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export {
  CustomerFilters,
  applyFilters,
  hasActiveFilters,
  EMPTY_FILTERS,
  type CustomerFilterState,
  type CustomerFiltersProps,
  type CustomerListColumnOption,
}
