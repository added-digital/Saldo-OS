"use client"

import * as React from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
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
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
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
  nvrStartFeeChargedAt: string | null
  fortnoxPrice: number
  redaPrice: number
  diffVsList: number
  nvrRecurring: number
  nvrStartFee: number
  nvrPrice: number
  notInvoiced: boolean
  clientListOnly: boolean
  nvrOnly: boolean
  missingConfig: boolean
  comment: string | null
  status: string | null
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
    | "nvrStartFeeChargedAt"
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
}: {
  rows: EditableRow[]
  onEdit: (databaseNumber: string, patch: Patch) => void
  onSave: (databaseNumber: string) => void
  t: (key: string, fallback: string) => string
}) {
  const [query, setQuery] = React.useState("")
  const [onlyReview, setOnlyReview] = React.useState(false)
  const [onlyLoss, setOnlyLoss] = React.useState(false)
  const [pageSize, setPageSize] = React.useState<number>(25)
  const [pageIndex, setPageIndex] = React.useState(0)

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
    return list
  }, [rows, query, onlyReview, onlyLoss])

  // Reset to the first page whenever the filtered set or page size changes.
  React.useEffect(() => {
    setPageIndex(0)
  }, [query, onlyReview, onlyLoss, pageSize])

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
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {t("pricing.table.rows", "rader")}
        </span>
      </div>

      <div className="rounded-md border [&_[data-slot=table-container]]:!overflow-x-auto">
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
                      <div className="truncate font-medium">{r.name || "—"}</div>
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
                  <Input
                    value={r.fortnoxCustomerNumber ?? ""}
                    onChange={(e) =>
                      onEdit(r.databaseNumber, { fortnoxCustomerNumber: e.target.value || null })
                    }
                    placeholder={t("pricing.table.ejPlaceholder", "EJ")}
                    className="h-8"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    value={String(r.discountPercent ?? 0)}
                    onChange={(e) =>
                      onEdit(r.databaseNumber, { discountPercent: numOrNull(e.target.value) ?? 0 })
                    }
                    className="h-8 text-right"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    value={r.fixedPriceFortnox == null ? "" : String(r.fixedPriceFortnox)}
                    onChange={(e) =>
                      onEdit(r.databaseNumber, { fixedPriceFortnox: numOrNull(e.target.value) })
                    }
                    className="h-8 text-right"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    value={r.fixedPriceReda == null ? "" : String(r.fixedPriceReda)}
                    onChange={(e) =>
                      onEdit(r.databaseNumber, { fixedPriceReda: numOrNull(e.target.value) })
                    }
                    className="h-8 text-right"
                  />
                </TableCell>
                <TableCell>
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
                        {r.nvrStartFee > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              onEdit(r.databaseNumber, {
                                nvrStartFeeChargedAt: new Date().toISOString(),
                              })
                            }
                            title={t(
                              "pricing.table.markStartFee",
                              "Startavgift ingår — klicka för att markera som fakturerad",
                            )}
                            className="ml-1 rounded bg-[var(--color-warning)]/15 px-1 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/25"
                          >
                            +{formatSek(r.nvrStartFee)}
                          </button>
                        ) : null}
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
                </TableCell>
                <TableCell>
                  <Input
                    value={r.comment ?? ""}
                    onChange={(e) => onEdit(r.databaseNumber, { comment: e.target.value || null })}
                    placeholder={t("pricing.table.commentPlaceholder", "Kommentar…")}
                    className="h-8 min-w-[180px]"
                  />
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
    </div>
  )
}
