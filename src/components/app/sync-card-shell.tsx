import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Shared shell for every card on the Sync control panel (Fortnox steps, SIE,
 * Bolagsverket). One skeleton so the grid reads uniformly and scales as steps
 * are added:
 *   • icon chip + title, with an optional "Running" badge on the right
 *   • description text
 *   • actions pinned to the bottom (mt-auto) so buttons align across a row
 *     regardless of how long each description is
 * Cards stretch to equal height within a grid row via `h-full`.
 */
export function SyncCardShell({
  icon: Icon,
  title,
  description,
  running = false,
  runningLabel = "Running",
  children,
}: {
  icon: React.ElementType
  title: string
  description: string
  running?: boolean
  runningLabel?: string
  children: React.ReactNode
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="size-[18px]" />
            </span>
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
          </div>
          {running ? (
            <Badge variant="secondary" className="shrink-0 font-normal">
              <Loader2 className="mr-1 size-3 animate-spin" />
              {runningLabel}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="mt-auto pt-4">{children}</div>
      </CardContent>
    </Card>
  )
}
