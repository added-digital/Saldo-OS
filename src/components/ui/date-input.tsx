"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

/**
 * Controlled `YYYY-MM-DD` date field that behaves identically across browsers.
 *
 * We deliberately avoid the native `<input type="date">` because its year
 * segment accepts up to six digits before it hands off to the month segment,
 * which trips users up (they type "202604" into the year). This masked text
 * input caps the year at four digits, auto-inserts the dashes, and advances
 * deterministically.
 *
 * The value/onChange contract mirrors the old native input: `value` is an ISO
 * `YYYY-MM-DD` string (or ""), and `onChange` only fires a non-empty value once
 * a complete, valid date has been typed — partial input reports "" just like
 * the native control did, so downstream save logic is unchanged.
 */

/** Format a raw digit string into `YYYY-MM-DD` as the user types. */
function maskDigits(digits: string): string {
  const d = digits.slice(0, 8)
  let out = d.slice(0, 4)
  if (d.length > 4) out += "-" + d.slice(4, 6)
  if (d.length > 6) out += "-" + d.slice(6, 8)
  return out
}

/** True when `text` is a complete, calendar-valid `YYYY-MM-DD` date. */
function isCompleteValid(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

interface DateInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: string
  onChange: (value: string) => void
}

function DateInput({ value, onChange, className, ...props }: DateInputProps) {
  // Local display state keeps partial typing on screen while `value` only ever
  // carries a complete-or-empty ISO string to the parent.
  const [text, setText] = React.useState(value ?? "")

  // Re-sync the display when the value changes from the outside (e.g. the
  // "Auto" deadline button), without clobbering an in-progress partial edit.
  React.useEffect(() => {
    const normalized = value ?? ""
    setText((prev) => {
      if (isCompleteValid(prev) && prev === normalized) return prev
      if (!isCompleteValid(prev) && normalized === "") return prev
      return normalized
    })
  }, [value])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const masked = maskDigits(e.target.value.replace(/\D/g, ""))
    setText(masked)
    onChange(isCompleteValid(masked) ? masked : "")
  }

  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={10}
      placeholder={props.placeholder ?? "ÅÅÅÅ-MM-DD"}
      value={text}
      onChange={handleChange}
      className={cn(className)}
    />
  )
}

export { DateInput }
