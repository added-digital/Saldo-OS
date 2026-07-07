"use client"

import * as React from "react"
import { Check, ChevronDown, Filter } from "lucide-react"

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
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

export type BvFilter = "all" | "sent" | "registered" | "sent_unconfirmed"

const ALL = "all"

type ClearedMode = "hide" | "show" | "only"

interface EngagementFiltersProps {
  t: (key: string, fallback?: string) => string
  showBv: boolean
  bv: BvFilter
  onBvChange: (value: BvFilter) => void
  cleared: ClearedMode
  onClearedChange: (value: ClearedMode) => void
  yearOptions: string[]
  years: string[]
  onToggleYear: (year: string) => void
  activeCount: number
  onClearAll: () => void
  clearDisabled: boolean
}

function FilterSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
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

function CheckRow({
  id,
  checked,
  onChange,
  label,
}: {
  id: string
  checked: boolean
  onChange: () => void
  label: React.ReactNode
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  )
}

export function EngagementFilters(props: EngagementFiltersProps) {
  const {
    t,
    showBv,
    bv,
    onBvChange,
    cleared,
    onClearedChange,
    yearOptions,
    years,
    onToggleYear,
    activeCount,
    onClearAll,
    clearDisabled,
  } = props

  const bvOptions: { value: Exclude<BvFilter, "all">; label: string }[] = [
    { value: "sent", label: t("engagements.filter.bv.sent", "Sent to Bolagsverket") },
    { value: "registered", label: t("engagements.filter.bv.registered", "Registered by Bolagsverket") },
    { value: "sent_unconfirmed", label: t("engagements.filter.bv.sentUnconfirmed", "Sent, not confirmed") },
  ]

  const clearedOptions: { value: ClearedMode; label: string }[] = [
    { value: "hide", label: t("engagements.filter.cleared.hide", "Hide cleared") },
    { value: "show", label: t("engagements.filter.cleared.show", "Show cleared") },
    { value: "only", label: t("engagements.filter.cleared.only", "Only cleared") },
  ]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Filter className="size-3.5" />
          {t("engagements.filter.button", "Filters")}
          {activeCount > 0 ? (
            <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 px-1 text-xs">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[20rem] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("engagements.filter.title", "Filters")}</p>
          <p className="text-xs text-muted-foreground">
            {t("engagements.filter.subtitle", "Refine which engagements are shown.")}
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {showBv ? (
            <FilterSection
              title={t("engagements.filter.section.bolagsverket", "Bolagsverket")}
              count={bv === "all" ? 0 : 1}
              defaultOpen
            >
              <div className="space-y-2">
                {bvOptions.map((o) => (
                  <CheckRow
                    key={o.value}
                    id={`eng-filter-bv-${o.value}`}
                    checked={bv === o.value}
                    onChange={() => onBvChange(bv === o.value ? "all" : o.value)}
                    label={o.label}
                  />
                ))}
              </div>
            </FilterSection>
          ) : null}

          <FilterSection
            title={t("engagements.filter.section.year", "Fiscal year")}
            count={years.length}
          >
            {yearOptions.length > 0 ? (
              <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {yearOptions.map((y) => (
                  <CheckRow
                    key={y}
                    id={`eng-filter-year-${y}`}
                    checked={years.includes(y)}
                    onChange={() => onToggleYear(y)}
                    label={y}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("engagements.filter.none", "None available.")}
              </p>
            )}
          </FilterSection>

          <FilterSection
            title={t("engagements.filter.section.cleared", "Cleared cards")}
            count={cleared !== "hide" ? 1 : 0}
          >
            <div className="space-y-2">
              {clearedOptions.map((o) => (
                <CheckRow
                  key={o.value}
                  id={`eng-filter-cleared-${o.value}`}
                  checked={cleared === o.value}
                  onChange={() => onClearedChange(o.value)}
                  label={o.label}
                />
              ))}
            </div>
          </FilterSection>
        </div>

        <div className="border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-0 text-xs text-muted-foreground"
            onClick={onClearAll}
            disabled={clearDisabled}
          >
            {t("engagements.filter.clearAll", "Clear all filters")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Searchable single-select picker with an explicit "All" option — mirrors the
 * Reports filters. Used for customer manager and team in the board toolbar so
 * those stay quick to reach and consistent with the rest of the app.
 */
export function ManagerFilter({
  value,
  onChange,
  options,
  allLabel,
  searchPlaceholder,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ id: string; name: string }>
  allLabel: string
  searchPlaceholder: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.id === value) ?? null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-[180px] justify-between font-normal">
          <span className="truncate">
            {value === ALL ? allLabel : (selected?.name ?? allLabel)}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandItem
              value={allLabel}
              onSelect={() => {
                onChange(ALL)
                setOpen(false)
              }}
            >
              <Check className={cn("size-4", value === ALL ? "opacity-100" : "opacity-0")} />
              {allLabel}
            </CommandItem>
            <CommandEmpty>—</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={o.name}
                onSelect={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
              >
                <Check className={cn("size-4", value === o.id ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{o.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
