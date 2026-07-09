"use client"

import * as React from "react"
import { ChevronDown, Filter } from "lucide-react"

import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const STATUS_OPTIONS: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "offer_sent",
  "won",
  "lost",
  "archived",
  "spam",
]

const STATUS_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  offer_sent: "Offer sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
  spam: "Spam",
}

interface LeadFilterState {
  /** Selected statuses. Empty array = all statuses. */
  statuses: WebsiteLeadStatus[]
}

const EMPTY_LEAD_FILTERS: LeadFilterState = { statuses: [] }

function hasActiveLeadFilters(filters: LeadFilterState): boolean {
  return filters.statuses.length > 0
}

function applyLeadFilters(
  leads: WebsiteLead[],
  filters: LeadFilterState,
): WebsiteLead[] {
  if (filters.statuses.length === 0) return leads
  return leads.filter((lead) => filters.statuses.includes(lead.status))
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
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b last:border-b-0">
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
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  )
}

interface LeadFiltersProps {
  leads: WebsiteLead[]
  filters: LeadFilterState
  onFiltersChange: (filters: LeadFilterState) => void
  t: (key: string, fallback?: string) => string
}

function LeadFilters({ leads, filters, onFiltersChange, t }: LeadFiltersProps) {
  const statusCounts = React.useMemo(() => {
    const counts = {} as Record<WebsiteLeadStatus, number>
    for (const status of STATUS_OPTIONS) counts[status] = 0
    for (const lead of leads) {
      if (lead.status in counts) counts[lead.status] += 1
    }
    return counts
  }, [leads])

  const activeCount = filters.statuses.length

  function toggleStatus(status: WebsiteLeadStatus) {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status]
    onFiltersChange({ ...filters, statuses: next })
  }

  function clearAll() {
    onFiltersChange(EMPTY_LEAD_FILTERS)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5">
          <Filter className="size-3.5" />
          {t("leads.filter.button", "Filters")}
          {activeCount > 0 ? (
            <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 px-1 text-xs">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[20rem] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("leads.filter.title", "Filters")}</p>
          <p className="text-xs text-muted-foreground">
            {t("leads.filter.subtitle", "Refine which leads are shown.")}
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          <FilterSection
            title={t("leads.filter.section.status", "Status")}
            count={filters.statuses.length}
            defaultOpen
          >
            <div className="space-y-2">
              {STATUS_OPTIONS.map((status) => {
                const checked = filters.statuses.includes(status)
                const id = `lead-filter-status-${status}`

                return (
                  <label
                    key={status}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() => toggleStatus(status)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t(`leads.status.${status}`, STATUS_LABEL[status])}
                    </span>
                    <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[11px]">
                      {statusCounts[status]}
                    </Badge>
                  </label>
                )
              })}
            </div>
          </FilterSection>
        </div>

        <div className="border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-0 text-xs text-muted-foreground"
            onClick={clearAll}
            disabled={!hasActiveLeadFilters(filters)}
          >
            {t("leads.filter.clearAll", "Clear all filters")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export {
  LeadFilters,
  applyLeadFilters,
  hasActiveLeadFilters,
  EMPTY_LEAD_FILTERS,
  type LeadFilterState,
  type LeadFiltersProps,
}
