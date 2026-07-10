"use client"

import * as React from "react"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Info,
  Loader2,
  Search,
} from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { LicenseLine } from "@/lib/pricing/compute"
import { formatSek } from "./pricing-summary-cards"

/** The editable subset of a priced row. */
export interface EditableRow {
  databaseNumber: string
  orgNumber: string
  name: string
  fortnoxCustomerNumber: string | null
  discountPercent: number
  fixedPriceFortnox: number | null
  fixedPriceReda: number | null
  fixedPriceNvr: number | null
  listPrice: number
  fixedCost: number
  extraLicenseCost: number
  redaCost: number
  nvrShareholders: number
  hasAktiebok: boolean
  fortnoxPrice: number
  redaPrice: number
  diffVsList: number
  nvrRecurring: number
  nvrPrice: number
  notInvoiced: boolean
  billToName: string | null
  billToOrgNumber: string | null
  billToMismatch: boolean
  billToUnknown: boolean
  clientListOnly: boolean
  nvrOnly: boolean
  missingConfig: boolean
  comment: string | null
  status: string | null
  /** Individual Fortnox license lines (excludes the base fee). */
  licenses: LicenseLine[]
  /** Local UI: unsaved edits present. */
  dirty?: boolean
  saving?: boolean
}

/** Recurring status vocabulary from the original workbook's Kundnr sheet. */
const STATUS_OPTIONS = [
  "OK",
  "Faktureras ej",
  "Faktureras annat bolag",
  "ÅR",
  "Ingår i priset",
  "Kolla upp",
  "Avtal Fortnox",
] as const

type Patch = Partial<
  Pick<
    EditableRow,
    | "fortnoxCustomerNumber"
    | "discountPercent"
    | "fixedPriceFortnox"
    | "fixedPriceReda"
    | "fixedPriceNvr"
    | "comment"
    | "status"
  >
>

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const

/**
 * Net margin for one client: all revenue (Fortnox + Reda + NVR) minus all cost
 * Saldo pays (fixed per-client fee + extra licenses + Reda). NVR has no cost
 * basis in the files, so its full charge counts as margin.
 */
const netOf = (r: EditableRow) =>
  r.fortnoxPrice +
  r.redaPrice +
  r.nvrPrice -
  r.fixedCost -
  r.extraLicenseCost -
  r.redaCost

const numOrNull = (v: string): number | null => {
  const t = v.trim()
  if (t === "") return null
  const n = Number(t.replace(",", "."))
  return Number.isFinite(n) ? n : null
}

export function PricingResultsTable({
  rows,
  onEdit,
  onSave,
  t,
  readOnly = false,
}: {
  rows: EditableRow[]
  onEdit: (databaseNumber: string, patch: Patch) => void
  onSave: (databaseNumber: string) => void
  t: (key: string, fallback: string) => string
  /** When true, all per-client fields render as plain text (no editing/saving). */
  readOnly?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [onlyReview, setOnlyReview] = React.useState(false)
  const [onlyLoss, setOnlyLoss] = React.useState(false)
  // Filter by one or more statuses (empty = all). Filter to companies whose only
  // billable service is the Digital Aktiebok (NVR), i.e. no Fortnox license lines
  // and no Reda.
  const [statusFilter, setStatusFilter] = React.useState<string[]>([])
  const [onlyAktiebok, setOnlyAktiebok] = React.useState(false)
  // The row whose license breakdown is shown in the modal (null = closed).
  const [detailRow, setDetailRow] = React.useState<EditableRow | null>(null)
  const [pageSize, setPageSize] = React.useState<number>(25)
  const [pageIndex, setPageIndex] = React.useState(0)

  // Status options for the filter: the known vocabulary plus any custom statuses
  // that actually occur in the data.
  const statusFilterOptions = React.useMemo(() => {
    const set = new Set<string>(STATUS_OPTIONS as readonly string[])
    for (const r of rows) if (r.status) set.add(r.status)
    return [...set]
  }, [rows])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const digits = q.replace(/\D/g, "")
    let list = rows
    if (q)
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (digits !== "" && r.orgNumber.replace(/\D/g, "").includes(digits)) ||
          (r.databaseNumber !== "" && digits !== "" && r.databaseNumber.includes(digits)) ||
          (r.fortnoxCustomerNumber ?? "").toLowerCase().includes(q),
      )
    if (onlyReview) list = list.filter((r) => r.missingConfig || r.dirty)
    if (onlyLoss) list = list.filter((r) => netOf(r) < 0)
    if (statusFilter.length)
      list = list.filter((r) => r.status != null && statusFilter.includes(r.status))
    if (onlyAktiebok)
      // Aktiebok-only = present only in the NVR file, with no Fortnox/Reda
      // footprint — the same flag that drives the "Endast aktiebok" row badge,
      // so the filter and the badge now agree. The previous check keyed off
      // licenses.length, which collapsed when rows loaded without a populated
      // licenses array and let every Fortnox client that also has aktiebok in.
      list = list.filter((r) => r.nvrOnly)
    return list
  }, [rows, query, onlyReview, onlyLoss, statusFilter, onlyAktiebok])

  // Reset to the first page whenever the filtered set or page size changes.
  React.useEffect(() => {
    setPageIndex(0)
  }, [query, onlyReview, onlyLoss, statusFilter, onlyAktiebok, pageSize])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(pageIndex, pageCount - 1)
  const shown = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize)
  const rangeStart = filtered.length === 0 ? 0 : safePage * pageSize + 1
  const rangeEnd = Math.min(filtered.length, safePage * pageSize + pageSize)

  const th = "text-right tabular-nums"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pricing.table.search", "Sök namn, orgnr, kundnr…")}
            className="pl-8"
          />
        </div>
        <Button
          variant={onlyReview ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyReview((v) => !v)}
        >
          {t("pricing.table.review", "Att granska / ändrade")}
        </Button>
        <Button
          variant={onlyLoss ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyLoss((v) => !v)}
        >
          {t("pricing.table.onlyLoss", "Endast förlust")}
        </Button>

        {/* Status filter — multi-select (e.g. "Kolla upp", "Avtal Fortnox"). */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
            >
              {t("pricing.table.statusFilter", "Status")}
              {statusFilter.length ? (
                <Badge
                  variant="secondary"
                  className="ml-0.5 h-5 min-w-5 justify-center px-1 text-xs tabular-nums"
                >
                  {statusFilter.length}
                </Badge>
              ) : null}
              <ChevronDown className="size-4 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2">
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {statusFilterOptions.map((s) => {
                const checked = statusFilter.includes(s)
                return (
                  <label
                    key={s}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() =>
                        setStatusFilter((prev) =>
                          checked ? prev.filter((x) => x !== s) : [...prev, s],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{s}</span>
                  </label>
                )
              })}
            </div>
            {statusFilter.length ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-7 w-full text-xs text-muted-foreground"
                onClick={() => setStatusFilter([])}
              >
                {t("pricing.table.clearStatus", "Rensa status")}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>

        {/* Companies whose only service is the Digital Aktiebok. */}
        <Button
          variant={onlyAktiebok ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyAktiebok((v) => !v)}
        >
          {t("pricing.table.onlyAktiebok", "Endast Digital Aktiebok")}
        </Button>

        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {t("pricing.table.rows", "rader")}
        </span>
      </div>

      <div
        className={cn(
          "rounded-md border",
          // Give the table its own bounded scroll area (both axes) so the
          // header (vertical) and first column (horizontal) can stay pinned.
          "[&_[data-slot=table-container]]:!overflow-auto",
          "[&_[data-slot=table-container]]:max-h-[calc(100vh-18rem)]",
          // Pin the column headers to the top of the scroll area. Borders on
          // sticky cells get clipped, so use an inset box-shadow to draw the
          // top + bottom divider lines that outline the pinned header row.
          "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-20",
          "[&_thead_th]:bg-background",
          "[&_thead_th]:shadow-[inset_0_1px_0_var(--color-border-default),inset_0_-1px_0_var(--color-border-default)]",
          // Freeze the first column (company names) during horizontal scroll,
          // with a right-edge divider (box-shadow, since the border gets clipped).
          "[&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10",
          "[&_tbody_td:first-child]:bg-background",
          "[&_tbody_td:first-child]:shadow-[inset_-1px_0_0_var(--color-border-default)]",
          // The top-left header cell overlaps both frozen regions — keep it on
          // top, and give it both the header and right-edge dividers.
          "[&_thead_th:first-child]:sticky [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-30",
          "[&_thead_th:first-child]:shadow-[inset_-1px_0_0_var(--color-border-default),inset_0_1px_0_var(--color-border-default),inset_0_-1px_0_var(--color-border-default)]",
          // Drop the static borders now drawn by the box-shadow dividers, else
          // they double up: the header row's bottom border and the first
          // column's right border.
          "[&_thead_tr]:border-b-0",
          "[&_thead_th:first-child]:border-r-0 [&_tbody_td:first-child]:border-r-0",
        )}
      >
        <Table className="min-w-[1720px]">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[220px]">{t("pricing.table.company", "Bolag")}</TableHead>
              <TableHead className="w-[110px]">{t("pricing.table.custNo", "Kundnr")}</TableHead>
              <TableHead className="w-[80px]">{t("pricing.table.discount", "Rabatt %")}</TableHead>
              <TableHead className="w-[100px]">{t("pricing.table.fixed", "Fast pris")}</TableHead>
              <TableHead className="w-[100px]">{t("pricing.table.redaFixed", "Fast Reda")}</TableHead>
              <TableHead className="w-[100px]">{t("pricing.table.nvrFixed", "Fast NVR")}</TableHead>
              <TableHead className={th}>{t("pricing.table.list", "Listpris")}</TableHead>
              <TableHead className={th}>{t("pricing.table.priceFortnox", "Kundpris")}</TableHead>
              <TableHead className={th}>{t("pricing.table.diff", "Diff")}</TableHead>
              <TableHead className={th}>{t("pricing.table.priceReda", "Reda")}</TableHead>
              <TableHead className={th}>{t("pricing.table.priceNvr", "NVR")}</TableHead>
              <TableHead className={th}>{t("pricing.table.net", "Netto")}</TableHead>
              <TableHead className="w-[150px]">{t("pricing.table.status", "Status")}</TableHead>
              <TableHead className="min-w-[200px]">{t("pricing.table.comment", "Kommentar")}</TableHead>
              <TableHead className="w-[44px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow
                key={r.databaseNumber}
                className={cn(
                  r.notInvoiced && "opacity-55",
                  r.clientListOnly && "bg-muted/30",
                )}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setDetailRow(r)}
                        title={t("pricing.table.viewLicenses", "Visa licenser")}
                        className="max-w-full cursor-pointer truncate text-left font-medium underline-offset-2 hover:underline"
                      >
                        {r.name || "—"}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {r.orgNumber || "—"}
                        {!r.nvrOnly ? (
                          <span className="ml-1 opacity-60">· {r.databaseNumber}</span>
                        ) : null}
                      </div>
                    </div>
                    {r.nvrOnly ? (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-[var(--color-info)]/40 text-[10px] text-[var(--color-info)]"
                      >
                        {t("pricing.table.nvrOnly", "Endast aktiebok")}
                      </Badge>
                    ) : null}
                    {r.missingConfig ? (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {t("pricing.table.new", "Ny")}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {readOnly ? (
                      <span className="flex-1 tabular-nums">
                        {r.fortnoxCustomerNumber || "—"}
                      </span>
                    ) : (
                      <Input
                        value={r.fortnoxCustomerNumber ?? ""}
                        onChange={(e) =>
                          onEdit(r.databaseNumber, { fortnoxCustomerNumber: e.target.value || null })
                        }
                        placeholder={t("pricing.table.ejPlaceholder", "EJ")}
                        className="h-8"
                      />
                    )}
                    {r.billToMismatch ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="shrink-0 text-[var(--color-info)]">
                              <Info className="size-4" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[240px]">
                            <p className="font-medium">
                              {t("pricing.table.billsOther", "Faktureras annat bolag")}
                            </p>
                            <p>
                              {r.billToName ?? "—"}
                              {r.billToOrgNumber ? ` · ${r.billToOrgNumber}` : ""}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <div className="text-right tabular-nums text-muted-foreground">
                      {r.discountPercent ? `${r.discountPercent}%` : "—"}
                    </div>
                  ) : (
                    <Input
                      inputMode="decimal"
                      value={String(r.discountPercent ?? 0)}
                      onChange={(e) =>
                        onEdit(r.databaseNumber, { discountPercent: numOrNull(e.target.value) ?? 0 })
                      }
                      className="h-8 text-right"
                    />
                  )}
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <div className="text-right tabular-nums text-muted-foreground">
                      {r.fixedPriceFortnox == null ? "—" : formatSek(r.fixedPriceFortnox)}
                    </div>
                  ) : (
                    <Input
                      inputMode="decimal"
                      value={r.fixedPriceFortnox == null ? "" : String(r.fixedPriceFortnox)}
                      onChange={(e) =>
                        onEdit(r.databaseNumber, { fixedPriceFortnox: numOrNull(e.target.value) })
                      }
                      className="h-8 text-right"
                    />
                  )}
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <div className="text-right tabular-nums text-muted-foreground">
                      {r.fixedPriceReda == null ? "—" : formatSek(r.fixedPriceReda)}
                    </div>
                  ) : (
                    <Input
                      inputMode="decimal"
                      value={r.fixedPriceReda == null ? "" : String(r.fixedPriceReda)}
                      onChange={(e) =>
                        onEdit(r.databaseNumber, { fixedPriceReda: numOrNull(e.target.value) })
                      }
                      className="h-8 text-right"
                    />
                  )}
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <div className="text-right tabular-nums text-muted-foreground">
                      {r.fixedPriceNvr == null ? "—" : formatSek(r.fixedPriceNvr)}
                    </div>
                  ) : (
                    <Input
                      inputMode="decimal"
                      value={r.fixedPriceNvr == null ? "" : String(r.fixedPriceNvr)}
                      onChange={(e) =>
                        onEdit(r.databaseNumber, { fixedPriceNvr: numOrNull(e.target.value) })
                      }
                      className="h-8 text-right"
                      disabled={!r.hasAktiebok}
                      placeholder={r.hasAktiebok ? undefined : "—"}
                    />
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatSek(r.listPrice)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatSek(r.fortnoxPrice)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.diffVsList < 0 ? "text-[var(--color-error)]" : "text-muted-foreground",
                  )}
                >
                  {formatSek(r.diffVsList)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatSek(r.redaPrice)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.hasAktiebok ? (
                    <>
                      <div className="font-medium">{formatSek(r.nvrPrice)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {r.nvrShareholders} {t("pricing.table.shareholders", "ägare")}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-semibold tabular-nums",
                    netOf(r) < 0
                      ? "text-[var(--color-error)]"
                      : netOf(r) > 0
                        ? "text-[var(--color-success)]"
                        : "text-muted-foreground",
                  )}
                  title={
                    `Fortnox ${formatSek(r.fortnoxPrice - r.fixedCost - r.extraLicenseCost)} · ` +
                    `Reda ${formatSek(r.redaPrice - r.redaCost)} · ` +
                    `NVR ${formatSek(r.nvrPrice)}`
                  }
                >
                  {formatSek(netOf(r))}
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <span className="text-xs text-muted-foreground">{r.status || "—"}</span>
                  ) : (
                    <select
                      value={r.status ?? ""}
                      onChange={(e) => onEdit(r.databaseNumber, { status: e.target.value || null })}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">—</option>
                      {(STATUS_OPTIONS as readonly string[]).includes(r.status ?? "")
                        ? null
                        : r.status
                          ? <option value={r.status}>{r.status}</option>
                          : null}
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </TableCell>
                <TableCell>
                  {readOnly ? (
                    <span className="text-xs text-muted-foreground">{r.comment || "—"}</span>
                  ) : (
                    <Input
                      value={r.comment ?? ""}
                      onChange={(e) => onEdit(r.databaseNumber, { comment: e.target.value || null })}
                      placeholder={t("pricing.table.commentPlaceholder", "Kommentar…")}
                      className="h-8 min-w-[180px]"
                    />
                  )}
                </TableCell>
                <TableCell>
                  {r.dirty ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => onSave(r.databaseNumber)}
                      disabled={r.saving}
                      title={t("pricing.table.save", "Spara")}
                    >
                      {r.saving ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4 text-[var(--color-success)]" />
                      )}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {filtered.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("pricing.table.rowsPerPage", "Rader per sida")}</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              aria-label={t("pricing.table.rowsPerPage", "Rader per sida")}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="ml-1 tabular-nums">
              {rangeStart}–{rangeEnd} {t("pricing.table.of", "av")} {filtered.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setPageIndex(0)}
              disabled={safePage === 0}
              title={t("pricing.table.first", "Första sidan")}
            >
              <ChevronsLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              title={t("pricing.table.prev", "Föregående")}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-sm text-muted-foreground tabular-nums">
              {t("pricing.table.page", "Sida")} {safePage + 1} {t("pricing.table.of", "av")}{" "}
              {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              title={t("pricing.table.next", "Nästa")}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setPageIndex(pageCount - 1)}
              disabled={safePage >= pageCount - 1}
              title={t("pricing.table.last", "Sista sidan")}
            >
              <ChevronsRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <LicenseDetailsDialog
        row={
          detailRow
            ? (rows.find((r) => r.databaseNumber === detailRow.databaseNumber) ??
              detailRow)
            : null
        }
        onOpenChange={(open) => {
          if (!open) setDetailRow(null)
        }}
        onEdit={onEdit}
        onSave={onSave}
        readOnly={readOnly}
        t={t}
      />
    </div>
  )
}

/** Modal listing every license/service a single customer carries, and — when
 *  not read-only — the same editable overrides available inline in the row. */
function LicenseDetailsDialog({
  row,
  onOpenChange,
  onEdit,
  onSave,
  readOnly = false,
  t,
}: {
  row: EditableRow | null
  onOpenChange: (open: boolean) => void
  onEdit: (databaseNumber: string, patch: Patch) => void
  onSave: (databaseNumber: string) => void
  readOnly?: boolean
  t: (key: string, fallback: string) => string
}) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{row?.name || "—"}</DialogTitle>
          <DialogDescription>
            {row?.orgNumber || "—"}
            {row && !row.nvrOnly ? ` · ${row.databaseNumber}` : ""}
          </DialogDescription>
        </DialogHeader>

        {row ? (
          <div className="space-y-5">
            {!readOnly ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("pricing.table.custNo", "Kundnr")}>
                    <Input
                      value={row.fortnoxCustomerNumber ?? ""}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, {
                          fortnoxCustomerNumber: e.target.value || null,
                        })
                      }
                      placeholder={t("pricing.table.ejPlaceholder", "EJ")}
                      className="h-8"
                    />
                  </Field>
                  <Field label={t("pricing.table.discount", "Rabatt %")}>
                    <Input
                      inputMode="decimal"
                      value={String(row.discountPercent ?? 0)}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, {
                          discountPercent: numOrNull(e.target.value) ?? 0,
                        })
                      }
                      className="h-8 text-right"
                    />
                  </Field>
                  <Field label={t("pricing.table.fixed", "Fast pris")}>
                    <Input
                      inputMode="decimal"
                      value={row.fixedPriceFortnox == null ? "" : String(row.fixedPriceFortnox)}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, {
                          fixedPriceFortnox: numOrNull(e.target.value),
                        })
                      }
                      className="h-8 text-right"
                    />
                  </Field>
                  <Field label={t("pricing.table.redaFixed", "Fast Reda")}>
                    <Input
                      inputMode="decimal"
                      value={row.fixedPriceReda == null ? "" : String(row.fixedPriceReda)}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, {
                          fixedPriceReda: numOrNull(e.target.value),
                        })
                      }
                      className="h-8 text-right"
                    />
                  </Field>
                  <Field label={t("pricing.table.nvrFixed", "Fast NVR")}>
                    <Input
                      inputMode="decimal"
                      value={row.fixedPriceNvr == null ? "" : String(row.fixedPriceNvr)}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, {
                          fixedPriceNvr: numOrNull(e.target.value),
                        })
                      }
                      className="h-8 text-right"
                      disabled={!row.hasAktiebok}
                      placeholder={row.hasAktiebok ? undefined : "—"}
                    />
                  </Field>
                  <Field label={t("pricing.table.status", "Status")}>
                    <select
                      value={row.status ?? ""}
                      onChange={(e) =>
                        onEdit(row.databaseNumber, { status: e.target.value || null })
                      }
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">—</option>
                      {(STATUS_OPTIONS as readonly string[]).includes(row.status ?? "")
                        ? null
                        : row.status
                          ? <option value={row.status}>{row.status}</option>
                          : null}
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label={t("pricing.table.comment", "Kommentar")}>
                  <Input
                    value={row.comment ?? ""}
                    onChange={(e) =>
                      onEdit(row.databaseNumber, { comment: e.target.value || null })
                    }
                    placeholder={t("pricing.table.commentPlaceholder", "Kommentar…")}
                    className="h-8"
                  />
                </Field>
              </div>
            ) : null}

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("pricing.detail.services", "Tjänster")}
              </p>
              <LicenseList row={row} t={t} />
            </div>
          </div>
        ) : null}

        {row && !readOnly ? (
          <DialogFooter>
            <Button
              onClick={() => onSave(row.databaseNumber)}
              disabled={!row.dirty || row.saving}
            >
              {row.saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("pricing.table.save", "Spara")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Label + control row used inside the details dialog. */
function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** The list of services a customer has: base fee, Fortnox articles, Reda, aktiebok. */
function LicenseList({
  row,
  t,
}: {
  row: EditableRow
  t: (key: string, fallback: string) => string
}) {
  const items: Array<{ label: string; detail?: string; amount?: number }> = []

  // Base Fortnox subscription (the fixed per-client fee) — not for aktiebok-only.
  if (!row.nvrOnly && row.fixedCost > 0) {
    items.push({ label: t("pricing.licenses.base", "Fast licens (Fortnox)") })
  }
  // Individual Fortnox license articles.
  for (const l of row.licenses ?? []) {
    items.push({
      label: l.name || l.articleNo,
      detail: `${l.quantity} ${t("pricing.licenses.qty", "st")}`,
      amount: l.quantity * l.unitListPrice,
    })
  }
  // Reda document scanning.
  if (row.redaCost > 0) {
    items.push({ label: t("pricing.licenses.reda", "Reda (dokumentskanning)") })
  }
  // Digital Aktiebok (NVR).
  if (row.hasAktiebok) {
    items.push({
      label: t("pricing.licenses.aktiebok", "Digital Aktiebok"),
      detail: `${row.nvrShareholders} ${t("pricing.table.shareholders", "ägare")}`,
    })
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("pricing.licenses.none", "Inga licenser registrerade.")}
      </p>
    )
  }

  return (
    <ul className="divide-y">
      {items.map((it, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium">{it.label}</div>
            {it.detail ? (
              <div className="text-xs text-muted-foreground">{it.detail}</div>
            ) : null}
          </div>
          {typeof it.amount === "number" ? (
            <div className="shrink-0 tabular-nums text-muted-foreground">
              {formatSek(it.amount)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
