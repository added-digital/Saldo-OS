"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight, House } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"

interface BreadcrumbsProps {
  className?: string
}

function Breadcrumbs({ className }: BreadcrumbsProps) {
  const pathname = usePathname()
  const { t } = useTranslation()
  const [dynamicLabels, setDynamicLabels] = React.useState<Record<string, string>>({})

  const segments = React.useMemo(
    () => pathname.split("/").filter(Boolean),
    [pathname],
  )

  React.useEffect(() => {
    const isCustomerDetailsRoute = segments[0] === "customers" && Boolean(segments[1]) && segments[1] !== "contacts"
    const isTeamDetailsRoute =
      segments[0] === "settings" && segments[1] === "teams" && Boolean(segments[2])

    if (!isCustomerDetailsRoute && !isTeamDetailsRoute) {
      setDynamicLabels((current) => (Object.keys(current).length === 0 ? current : {}))
      return
    }

    const customerId = isCustomerDetailsRoute ? segments[1] : null
    const teamId = isTeamDetailsRoute ? segments[2] : null
    let cancelled = false

    async function loadDynamicName() {
      const supabase = createClient()
      if (customerId) {
        const { data } = await supabase
          .from("customers")
          .select("name")
          .eq("id", customerId)
          .maybeSingle()

        if (cancelled) return
        const customerRow = data as { name: string | null } | null
        const customerName = customerRow?.name?.trim()
        if (!customerName) return

        setDynamicLabels((current) => ({
          ...current,
          [`/customers/${customerId}`]: customerName,
        }))
        return
      }

      if (teamId) {
        const { data } = await supabase
          .from("teams")
          .select("name")
          .eq("id", teamId)
          .maybeSingle()

        if (cancelled) return
        const teamRow = data as { name: string | null } | null
        const teamName = teamRow?.name?.trim()
        if (!teamName) return

        setDynamicLabels((current) => ({
          ...current,
          [`/settings/teams/${teamId}`]: teamName,
        }))
      }
    }

    void loadDynamicName()

    return () => {
      cancelled = true
    }
  }, [pathname, segments])

  function translateSegmentLabel(segment: string, fallbackLabel: string): string {
    const keyBySegment: Record<string, string> = {
      customers: "navigation.items.customers",
      contacts: "navigation.items.contacts",
      reports: "navigation.items.reports",
      "key-metrics": "navigation.items.keyMetrics",
      "hit-list": "navigation.items.hitList",
      settings: "navigation.items.settings",
    }

    const key = keyBySegment[segment.toLowerCase()]
    return key ? t(key, fallbackLabel) : fallbackLabel
  }

  const breadcrumbs = [
    { label: t("common.home", "Home"), href: "/" },
    ...segments.map((segment, index) => {
      const href = "/" + segments.slice(0, index + 1).join("/")
      const fallbackLabel = segment
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())

      return {
        label:
          dynamicLabels[href] ??
          translateSegmentLabel(segment, fallbackLabel),
        href,
      }
    }),
  ]

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0 overflow-x-auto", className)}>
      <ol className="flex w-max items-center gap-1 whitespace-nowrap text-sm">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1
          const isRoot = index === 0

          return (
            <li key={crumb.href} className="flex items-center gap-1">
              {index > 0 && (
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              )}
              {isLast ? (
                isRoot ? (
                  <span
                    className="inline-flex items-center text-foreground"
                    aria-label={t("common.home", "Home")}
                  >
                    <House className="size-4" aria-hidden="true" />
                  </span>
                ) : (
                  <span className="max-w-40 truncate font-medium text-foreground">{crumb.label}</span>
                )
              ) : (
                <Link
                  href={crumb.href}
                  className="max-w-40 truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {isRoot ? <House className="size-4" aria-hidden="true" /> : crumb.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export { Breadcrumbs }
