"use client"

import * as React from "react"
import Link from "next/link"
import { Tags } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type PendingCustomer = { id: string; name: string }

const FETCH_LIMIT = 50

/**
 * Top-bar notification for customers imported from Fortnox that still need
 * their Bokslut setup / segmentation filled in. RLS (customers_select =
 * has_scope('customers')) means only customers-scope users get rows, so the
 * badge naturally only appears for them.
 */
export function SegmentationAlert() {
  const { t } = useTranslation()
  const [items, setItems] = React.useState<PendingCustomer[]>([])
  const [open, setOpen] = React.useState(false)

  const fetchPending = React.useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("customers")
      .select("id, name")
      .eq("needs_segmentation", true)
      .order("name")
      .limit(FETCH_LIMIT)
    setItems((data ?? []) as PendingCustomer[])
  }, [])

  React.useEffect(() => {
    void fetchPending()
    // Refetch when a customer's segmentation is saved elsewhere (see
    // customer-bokslut-setup.tsx), so the just-handled customer drops off the
    // list without a page reload.
    const onUpdated = () => {
      void fetchPending()
    }
    window.addEventListener("saldo:segmentation-updated", onUpdated)
    return () => {
      window.removeEventListener("saldo:segmentation-updated", onUpdated)
    }
  }, [fetchPending])

  if (items.length === 0) return null

  const countLabel = items.length === FETCH_LIMIT ? `${FETCH_LIMIT}+` : String(items.length)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t("topbar.needsSegmentation.title", "Customers need segmentation")}
        >
          <Tags className="size-5" />
          <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-semantic-error px-1 text-[10px] font-semibold leading-4 text-white">
            {countLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">{t("topbar.needsSegmentation.title", "Customers need segmentation")}</p>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {items.map((c) => (
            <Link
              key={c.id}
              href={`/customers/${c.id}?onboarding=1`}
              onClick={() => setOpen(false)}
              className="group flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted"
            >
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-xs font-medium text-brand-primary opacity-0 transition-opacity group-hover:opacity-100">
                {t("topbar.needsSegmentation.action", "Onboard")}
              </span>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
