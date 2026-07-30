"use client"

import * as React from "react"
import { Filter } from "lucide-react"

import type { TaskCategory } from "@/types/task"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * Category filter for the task board. Deliberately thinner than the engagement
 * filters popover — categories are the only thing in here, so the list sits
 * open instead of behind a collapsible section.
 */
export function TaskFilters({
  t,
  categories,
  selected,
  onToggle,
  onClearAll,
  clearDisabled,
}: {
  t: (key: string, fallback?: string) => string
  categories: TaskCategory[]
  selected: string[]
  onToggle: (id: string) => void
  onClearAll: () => void
  clearDisabled: boolean
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Filter className="size-3.5" />
          {t("tasks.filter.button", "Categories")}
          {selected.length > 0 ? (
            <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 px-1 text-xs">
              {selected.length}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[16rem] p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">{t("tasks.filter.title", "Categories")}</p>
          <p className="text-xs text-muted-foreground">
            {t("tasks.filter.subtitle", "Show only these kinds of task.")}
          </p>
        </div>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto px-4 py-3">
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("tasks.filter.none", "None available.")}
            </p>
          ) : (
            categories.map((c) => (
              <label
                key={c.id}
                htmlFor={`task-filter-cat-${c.id}`}
                className="flex cursor-pointer items-center gap-3 text-sm"
              >
                <Checkbox
                  id={`task-filter-cat-${c.id}`}
                  checked={selected.includes(c.id)}
                  onCheckedChange={() => onToggle(c.id)}
                />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
              </label>
            ))
          )}
        </div>

        <div className="border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-0 text-xs text-muted-foreground"
            onClick={onClearAll}
            disabled={clearDisabled}
          >
            {t("tasks.filter.clearAll", "Clear all filters")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
