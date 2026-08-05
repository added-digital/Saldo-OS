"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"
import { useUser } from "@/hooks/use-user"
import type { Absence, AbsenceType } from "@/types/resource"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const TYPE_ORDER: AbsenceType[] = ["semester", "sjuk", "foraldraledig", "ovrigt"]

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * Planerad frånvaro.
 *
 * Capacity without this is fiction in exactly the months it matters most: in a
 * Swedish byrå July and August are decided by who is away, not by how much work
 * came in. Historical absence already exists as time_reports.entry_type =
 * 'absence', but that is a record of what happened — future leave has to be
 * typed by a human, so it lives in its own table where no re-sync can touch it.
 *
 * Writing is your own row, or anyone's if you are admin; RLS enforces the same
 * rule server-side, so a denied write surfaces as a failed save rather than a
 * silent one.
 */
export function AbsenceSheet({
  open,
  onOpenChange,
  people,
  year,
  month,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  people: Array<{ id: string; name: string }>
  year: number
  month: number
  onChanged: () => void
}) {
  const { t, language } = useTranslation()
  const { user, isAdmin } = useUser()
  const supabase = React.useMemo(() => createClient(), [])
  const locale = language === "sv" ? "sv-SE" : "en-GB"

  const [rows, setRows] = React.useState<Array<Absence & { profile_name: string | null }>>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const monthStart = React.useMemo(() => isoDate(new Date(year, month - 1, 1)), [year, month])
  const monthEnd = React.useMemo(() => isoDate(new Date(year, month, 0)), [year, month])

  const [profileId, setProfileId] = React.useState(user.id)
  const [type, setType] = React.useState<AbsenceType>("semester")
  const [startDate, setStartDate] = React.useState(monthStart)
  const [endDate, setEndDate] = React.useState(monthStart)
  const [note, setNote] = React.useState("")

  const typeLabels: Record<AbsenceType, string> = React.useMemo(
    () => ({
      semester: t("belaggning.absence.type.semester", "Vacation"),
      sjuk: t("belaggning.absence.type.sjuk", "Sick leave"),
      foraldraledig: t("belaggning.absence.type.foraldraledig", "Parental leave"),
      ovrigt: t("belaggning.absence.type.ovrigt", "Other"),
    }),
    [t],
  )

  React.useEffect(() => {
    setStartDate(monthStart)
    setEndDate(monthStart)
  }, [monthStart])

  const load = React.useCallback(async () => {
    setLoading(true)
    // Anything overlapping the month, not only what starts inside it: a
    // four-week semester started in July is exactly what August needs to know.
    const { data, error } = await supabase
      .from("absences")
      .select("*, profiles!absences_profile_id_fkey(full_name)")
      .lte("start_date", monthEnd)
      .gte("end_date", monthStart)
      .order("start_date")

    if (error) {
      toast.error(t("belaggning.absence.loadFailed", "Could not load absences"))
      setRows([])
    } else {
      setRows(
        ((data ?? []) as Array<Absence & { profiles: { full_name: string | null } | null }>).map(
          (row) => ({ ...row, profile_name: row.profiles?.full_name ?? null }),
        ),
      )
    }
    setLoading(false)
  }, [supabase, monthStart, monthEnd, t])

  React.useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  async function add() {
    if (endDate < startDate) {
      toast.error(t("belaggning.absence.rangeInvalid", "The end date is before the start date"))
      return
    }

    setSaving(true)
    const { error } = await supabase.from("absences").insert({
      profile_id: profileId,
      start_date: startDate,
      end_date: endDate,
      type,
      note: note.trim() === "" ? null : note.trim(),
      created_by: user.id,
    } as never)
    setSaving(false)

    if (error) {
      toast.error(t("belaggning.absence.saveFailed", "Could not save the absence"))
      return
    }

    setNote("")
    toast.success(t("belaggning.absence.saved", "Absence saved"))
    await load()
    onChanged()
  }

  async function remove(id: string) {
    const previous = rows
    setRows((current) => current.filter((row) => row.id !== id))

    const { error } = await supabase.from("absences").delete().eq("id", id)

    if (error) {
      setRows(previous)
      toast.error(t("belaggning.absence.removeFailed", "Could not remove the absence"))
      return
    }
    onChanged()
  }

  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }),
    [locale],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("belaggning.absence.title", "Planned absence")}</SheetTitle>
          <SheetDescription>
            {t(
              "belaggning.absence.description",
              "Absence is subtracted from available hours. Without it, a July column looks overloaded because the capacity is wrong, not the work.",
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="absence-person">
                  {t("belaggning.absence.person", "Person")}
                </Label>
                <Select
                  value={profileId}
                  onValueChange={setProfileId}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="absence-person" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="absence-type">{t("belaggning.absence.type", "Type")}</Label>
                <Select value={type} onValueChange={(value) => setType(value as AbsenceType)}>
                  <SelectTrigger id="absence-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_ORDER.map((key) => (
                      <SelectItem key={key} value={key}>
                        {typeLabels[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="absence-start">
                  {t("belaggning.absence.from", "From")}
                </Label>
                <Input
                  id="absence-start"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="absence-end">{t("belaggning.absence.to", "To")}</Label>
                <Input
                  id="absence-end"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="absence-note">{t("belaggning.absence.note", "Note")}</Label>
              <Input
                id="absence-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t("belaggning.absence.notePlaceholder", "Optional")}
              />
            </div>

            <Button size="sm" onClick={() => void add()} disabled={saving}>
              <Plus className="size-4" />
              {t("belaggning.absence.add", "Add absence")}
            </Button>
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-medium">
              {t("belaggning.absence.thisMonth", "Absence this month")}
            </h3>
            {loading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("belaggning.absence.loading", "Loading…")}
              </p>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("belaggning.absence.empty", "Nobody is away this month")}
              </p>
            ) : (
              rows.map((row) => {
                const canEdit = isAdmin || row.profile_id === user.id
                return (
                  <div
                    key={row.id}
                    className="flex items-center gap-2 rounded-md border px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {row.profile_name ?? "—"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {typeLabels[row.type]} ·{" "}
                        {dateFormatter.format(new Date(`${row.start_date}T00:00:00`))} –{" "}
                        {dateFormatter.format(new Date(`${row.end_date}T00:00:00`))}
                        {row.note ? ` · ${row.note}` : ""}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(!canEdit && "invisible")}
                      onClick={() => void remove(row.id)}
                      aria-label={t("belaggning.absence.remove", "Remove absence")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
