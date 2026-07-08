"use client"

import * as React from "react"
import { Check, ChevronDown, X } from "lucide-react"

import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function prefixFilterScore(value: string, search: string): number {
  const normalizedValue = value.trim().toLowerCase()
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return 1
  return normalizedValue.startsWith(normalizedSearch) ? 1 : 0
}

interface CustomerOption {
  id: string
  name: string
  fortnox_customer_number: string | null
}

interface CustomerMultiSelectProps {
  customers: CustomerOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  lockedIds?: string[]
}

export function CustomerMultiSelect({
  customers,
  selectedIds,
  onChange,
  lockedIds = [],
}: CustomerMultiSelectProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const selectedCustomers = customers.filter((customer) => selectedIds.includes(customer.id))
  const lockedIdSet = new Set(lockedIds)

  function toggleCustomer(customerId: string) {
    if (lockedIdSet.has(customerId)) return
    if (selectedIds.includes(customerId)) {
      onChange(selectedIds.filter((id) => id !== customerId))
      return
    }
    onChange([...selectedIds, customerId])
  }

  function removeCustomer(customerId: string) {
    if (lockedIdSet.has(customerId)) return
    onChange(selectedIds.filter((id) => id !== customerId))
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">
              {selectedCustomers.length > 0
                ? `${selectedCustomers.length} ${t("customers.multiSelect.selectedSuffix", "selected")}`
                : t("customers.multiSelect.placeholder", "Select customers")}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command filter={(commandValue, search) => prefixFilterScore(commandValue, search)}>
            <CommandInput placeholder={t("customers.multiSelect.searchPlaceholder", "Search customers...")} />
            <CommandList>
              <CommandEmpty>{t("customers.multiSelect.empty", "No customers found.")}</CommandEmpty>
              {customers.map((customer) => {
                const selected = selectedIds.includes(customer.id)
                const locked = lockedIdSet.has(customer.id)

                return (
                  <CommandItem
                    key={customer.id}
                    value={customer.name}
                    onSelect={() => toggleCustomer(customer.id)}
                    className={cn(locked && "opacity-70")}
                  >
                    <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{customer.name}</span>
                      {customer.fortnox_customer_number && (
                        <span className="text-xs text-muted-foreground">
                          #{customer.fortnox_customer_number}
                        </span>
                      )}
                    </div>
                    {locked && <span className="text-xs text-muted-foreground">{t("customers.multiSelect.current", "Current")}</span>}
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedCustomers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedCustomers.map((customer) => {
            const locked = lockedIdSet.has(customer.id)

            return (
              <span
                key={customer.id}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs"
              >
                <span className="max-w-48 truncate">{customer.name}</span>
                {!locked && (
                  <button
                    type="button"
                    className="rounded-sm opacity-60 transition-opacity hover:opacity-100"
                    onClick={() => removeCustomer(customer.id)}
                  >
                    <X className="size-3" />
                    <span className="sr-only">{t("customers.multiSelect.remove", "Remove")} {customer.name}</span>
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
