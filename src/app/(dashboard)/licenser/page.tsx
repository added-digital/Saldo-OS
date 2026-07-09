"use client"

import * as React from "react"
import {
  AlertTriangle,
  Calculator,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Info,
  Loader2,
  Printer,
  RotateCcw,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PricingSummaryCards } from "@/components/app/pricing/pricing-summary-cards"
import {
  PricingResultsTable,
  type EditableRow,
} from "@/components/app/pricing/pricing-results-table"
import { priceClient } from "@/lib/pricing/engine"
import { summarizeRows, type PricedResultRow } from "@/lib/pricing/compute"

// Bump the version whenever the cached result shape changes so stale caches
// (e.g. from before the NVR line existed) are discarded instead of crashing.
const RESULT_STORAGE_KEY = "saldo.licenser.result.v4"

interface CalcResponse {
  ok: true
  period: string
  rows: PricedResultRow[]
  summary: ReturnType<typeof summarizeRows>
  diagnostics: {
    unknownArticles: { articleNo: string; name: string; unitPaidPrice: number }[]
    redaUnmatched: { name: string; orgNumber: string; scans: number }[]
    nvrUnmatched: { name: string; orgNumber: string; shareholders: number }[]
    fortnoxClientCount: number
    kundlistaCount: number
    mergedRowCount: number
    grandTotalPaid: number
    extraCostReconDiff: number
    fixedCostReconDiff: number
  }
}

function FilePicker({
  label,
  hint,
  file,
  onPick,
  accept,
  required,
}: {
  label: string
  hint: string
  file: File | null
  onPick: (f: File | null) => void
  accept: string
  required?: boolean
}) {
  const id = React.useId()
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-md border border-dashed p-4 transition-colors hover:bg-muted/40",
        file ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5" : "border-border",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileSpreadsheet className="size-4 text-muted-foreground" />
        {label}
        {required ? <span className="text-[var(--color-error)]">*</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">{file ? file.name : hint}</p>
      <input
        id={id}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </label>
  )
}

/** Collapsible notice for a list of unmatched companies (kept tidy by default). */
function UnmatchedNotice({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <details className="group rounded-md border p-3 text-sm text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Info className="size-4 shrink-0" />
        <span className="flex-1">
          <span className="font-medium text-foreground">{names.length}</span> {label}
        </span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 max-h-40 overflow-y-auto pl-6 text-xs leading-relaxed">
        {names.join(", ")}
      </div>
    </details>
  )
}

export default function LicenserPage() {
  const { t } = useTranslation()
  const { isAdmin } = useUser()

  const [fortnox, setFortnox] = React.useState<File | null>(null)
  const [kundlista, setKundlista] = React.useState<File | null>(null)
  const [reda, setReda] = React.useState<File | null>(null)
  const [nvr, setNvr] = React.useState<File | null>(null)
  const [calculating, setCalculating] = React.useState(false)

  const [period, setPeriod] = React.useState("")
  const [rows, setRows] = React.useState<EditableRow[]>([])
  const [diagnostics, setDiagnostics] = React.useState<CalcResponse["diagnostics"] | null>(null)

  const summary = React.useMemo(() => summarizeRows(rows as PricedResultRow[]), [rows])
  const hasResult = rows.length > 0

  // Persist the computed result across page refreshes (files can't be restored,
  // but the results/period/diagnostics can) so a reload doesn't wipe the work.
  const [hydrated, setHydrated] = React.useState(false)
  React.useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RESULT_STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as {
          period?: string
          rows?: EditableRow[]
          diagnostics?: CalcResponse["diagnostics"] | null
        }
        if (saved.rows?.length) {
          setRows(saved.rows.map((r) => ({ ...r, saving: false })))
          setPeriod(saved.period ?? "")
          setDiagnostics(saved.diagnostics ?? null)
        }
      }
    } catch {
      /* ignore malformed cache */
    }
    setHydrated(true)
  }, [])

  React.useEffect(() => {
    if (!hydrated) return
    try {
      if (rows.length) {
        sessionStorage.setItem(
          RESULT_STORAGE_KEY,
          JSON.stringify({ period, rows, diagnostics }),
        )
      } else {
        sessionStorage.removeItem(RESULT_STORAGE_KEY)
      }
    } catch {
      /* storage full or unavailable — non-fatal */
    }
  }, [hydrated, rows, period, diagnostics])

  async function handleCalculate() {
    if (!fortnox || !kundlista) {
      toast.error(t("pricing.err.filesRequired", "Ladda upp Fortnox-fil och kundlista."))
      return
    }
    setCalculating(true)
    try {
      const fd = new FormData()
      fd.append("fortnox", fortnox)
      fd.append("kundlista", kundlista)
      if (reda) fd.append("reda", reda)
      if (nvr) fd.append("nvr", nvr)
      const res = await fetch("/api/pricing/calculate", { method: "POST", body: fd })
      const json = (await res.json()) as CalcResponse | { error: string }
      if (!res.ok || !("ok" in json)) {
        toast.error(("error" in json && json.error) || t("pricing.err.calc", "Beräkningen misslyckades."))
        return
      }
      setPeriod(json.period)
      setRows(json.rows.map((r) => ({ ...r, dirty: false, saving: false })))
      setDiagnostics(json.diagnostics)
      toast.success(
        t("pricing.ok.calc", "Beräkning klar") + (json.period ? ` — ${json.period}` : ""),
      )
    } catch {
      toast.error(t("pricing.err.network", "Nätverksfel vid beräkning."))
    } finally {
      setCalculating(false)
    }
  }

  const recalcRow = React.useCallback((r: EditableRow): EditableRow => {
    const priced = priceClient({
      kundnr: r.fortnoxCustomerNumber,
      discountPct: r.discountPercent,
      fixedPrice: r.fixedPriceFortnox,
      redaFixedPrice: r.fixedPriceReda,
      listPrice: r.listPrice,
      extraLicenseCost: r.extraLicenseCost,
      redaCost: r.redaCost,
      nvrShareholders: r.nvrShareholders,
      hasAktiebok: r.hasAktiebok,
      nvrFixedPrice: r.fixedPriceNvr,
    })
    return {
      ...r,
      fortnoxPrice: priced.fortnoxPrice,
      redaPrice: priced.redaPrice,
      diffVsList: priced.diffVsList,
      nvrRecurring: priced.nvrRecurring,
      nvrPrice: priced.nvrPrice,
      notInvoiced: priced.notInvoiced,
    }
  }, [])

  const handleEdit = React.useCallback(
    (db: string, patch: Partial<EditableRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.databaseNumber === db ? recalcRow({ ...r, ...patch, dirty: true }) : r)),
      )
    },
    [recalcRow],
  )

  const handleSave = React.useCallback(
    async (db: string) => {
      const row = rows.find((r) => r.databaseNumber === db)
      if (!row) return
      setRows((prev) => prev.map((r) => (r.databaseNumber === db ? { ...r, saving: true } : r)))
      try {
        const res = await fetch("/api/pricing/customer-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgNumber: row.orgNumber,
            name: row.name,
            fortnoxCustomerNumber: row.fortnoxCustomerNumber,
            discountPercent: row.discountPercent,
            fixedPriceFortnox: row.fixedPriceFortnox,
            fixedPriceReda: row.fixedPriceReda,
            fixedPriceNvr: row.fixedPriceNvr,
            comment: row.comment,
            status: row.status,
          }),
        })
        if (!res.ok) throw new Error()
        setRows((prev) =>
          prev.map((r) =>
            r.databaseNumber === db ? { ...r, dirty: false, saving: false, missingConfig: false } : r,
          ),
        )
        toast.success(t("pricing.ok.saved", "Sparat"))
      } catch {
        setRows((prev) => prev.map((r) => (r.databaseNumber === db ? { ...r, saving: false } : r)))
        toast.error(t("pricing.err.save", "Kunde inte spara"))
      }
    },
    [rows, t],
  )

  async function handleExportExcel() {
    try {
      const { computationToWorkbook } = await import("@/lib/pricing/xlsx")
      const bytes = computationToWorkbook({
        period,
        rows: rows as PricedResultRow[],
        summary,
        diagnostics: diagnostics ?? ({} as CalcResponse["diagnostics"]),
      })
      const blob = new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `Licensfakturering_${period.replace(/\s+/g, "_") || "export"}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error(t("pricing.err.export", "Export misslyckades"))
    }
  }

  function handleClear() {
    setFortnox(null)
    setKundlista(null)
    setReda(null)
    setNvr(null)
    setRows([])
    setPeriod("")
    setDiagnostics(null)
    try {
      sessionStorage.removeItem(RESULT_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        {t("pricing.noAccess", "Endast administratörer har tillgång till licensfakturering.")}
      </div>
    )
  }

  const reconOk =
    diagnostics &&
    Math.abs(diagnostics.extraCostReconDiff) < 1 &&
    Math.abs(diagnostics.fixedCostReconDiff) < 1

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Calculator className="size-5 text-muted-foreground" />
            {t("pricing.title", "Licensfakturering")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "pricing.subtitle",
              "Läs in Fortnox- och Reda-filer, beräkna kundpriser och rabatter, och exportera underlag.",
            )}
          </p>
        </div>
        {hasResult ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleExportExcel}>
              <Download className="size-4" />
              {t("pricing.exportExcel", "Exportera Excel")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="size-4" />
              {t("pricing.print", "Skriv ut / PDF")}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear}>
              <RotateCcw className="size-4" />
              {t("pricing.clear", "Rensa")}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pricing.upload.title", "Läs in filer")}</CardTitle>
          <CardDescription>
            {t(
              "pricing.upload.desc",
              "Fortnox licensfil (Faktureringsunderlag) och kundlista krävs. Reda-fil är valfri.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilePicker
              label={t("pricing.upload.fortnox", "Fortnox licensfil")}
              hint={t("pricing.upload.fortnoxHint", "Faktureringsunderlag (.xlsx eller .csv)")}
              file={fortnox}
              onPick={setFortnox}
              accept=".xlsx,.xls,.csv,text/csv"
              required
            />
            <FilePicker
              label={t("pricing.upload.kundlista", "Kundlista (Saldo)")}
              hint={t("pricing.upload.kundlistaHint", "Klientlista (.csv)")}
              file={kundlista}
              onPick={setKundlista}
              accept=".csv,text/csv"
              required
            />
            <FilePicker
              label={t("pricing.upload.reda", "Reda-fil")}
              hint={t("pricing.upload.redaHint", "Skanningar (.xlsx eller .csv) — valfri")}
              file={reda}
              onPick={setReda}
              accept=".xlsx,.xls,.csv,text/csv"
            />
            <FilePicker
              label={t("pricing.upload.nvr", "NVR-fil (aktiebok)")}
              hint={t("pricing.upload.nvrHint", "Aktieägare (.csv eller .xlsx) — valfri")}
              file={nvr}
              onPick={setNvr}
              accept=".xlsx,.xls,.csv,text/csv"
            />
          </div>
          <Button onClick={handleCalculate} disabled={calculating || !fortnox || !kundlista}>
            {calculating ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t("pricing.calculate", "Beräkna")}
          </Button>
        </CardContent>
      </Card>

      {/* Diagnostics */}
      {diagnostics ? (
        <div className="space-y-2">
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border p-3 text-sm",
              reconOk
                ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/5"
                : "border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10",
            )}
          >
            {reconOk ? (
              <Info className="mt-0.5 size-4 text-[var(--color-success)]" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 text-[var(--color-warning)]" />
            )}
            <div>
              {reconOk
                ? t("pricing.diag.ok", "Avstämning OK — kostnaderna stämmer mot inläst fil.")
                : t("pricing.diag.diff", "Avstämningsdiff:") +
                  ` extra ${diagnostics.extraCostReconDiff}, fast ${diagnostics.fixedCostReconDiff}`}
              <span className="ml-1 text-muted-foreground">
                ({diagnostics.mergedRowCount} {t("pricing.diag.clients", "bolag")},{" "}
                {t("pricing.diag.totalPaid", "total kostnad")} {diagnostics.grandTotalPaid})
              </span>
            </div>
          </div>

          {diagnostics.unknownArticles.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 text-[var(--color-error)]" />
              <div>
                {t("pricing.diag.unknown", "Okända artiklar utan pris i prislistan:")}{" "}
                {diagnostics.unknownArticles.map((a) => `${a.name || a.articleNo} (${a.articleNo})`).join(", ")}
              </div>
            </div>
          ) : null}

          <UnmatchedNotice
            label={t(
              "pricing.diag.redaUnmatched",
              "Reda-rader kunde inte matchas mot orgnr/namn (bokförs på Saldo)",
            )}
            names={diagnostics.redaUnmatched.map((r) =>
              r.orgNumber ? `${r.name} (${r.orgNumber})` : r.name,
            )}
          />

          <UnmatchedNotice
            label={t(
              "pricing.diag.nvrUnmatched",
              "NVR-bolag kunde inte matchas mot orgnr/namn (aktiebok faktureras ej)",
            )}
            names={
              diagnostics.nvrUnmatched?.map((r) =>
                r.orgNumber ? `${r.name} (${r.orgNumber})` : r.name,
              ) ?? []
            }
          />
        </div>
      ) : null}

      {/* Summary + table */}
      {hasResult ? (
        <>
          <PricingSummaryCards summary={summary} period={period} t={t} />
          <PricingResultsTable rows={rows} onEdit={handleEdit} onSave={handleSave} t={t} />
        </>
      ) : null}
    </div>
  )
}
