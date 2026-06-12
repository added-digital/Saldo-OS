"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Textarea } from "@/components/ui/textarea"

export type MentionPerson = { id: string; name: string }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Return the ids of people whose `@Name` token appears in `text`. The negative
 * lookahead stops "@Anna" from also matching "@Annabelle"; a trailing space or
 * end-of-string still counts as a complete mention.
 */
export function extractMentionIds(text: string, people: MentionPerson[]): string[] {
  if (!text) return []
  const ids: string[] = []
  for (const p of people) {
    if (!p.name) continue
    const re = new RegExp(`@${escapeRegExp(p.name)}(?![\\p{L}\\p{N}])`, "u")
    if (re.test(text)) ids.push(p.id)
  }
  return ids
}

type ActiveQuery = { start: number; query: string }

/** Find the @-token currently being typed at the caret, if any. */
function activeQueryAt(value: string, caret: number): ActiveQuery | null {
  const before = value.slice(0, caret)
  const at = before.lastIndexOf("@")
  if (at === -1) return null
  // The '@' must start a token (beginning of input or after whitespace).
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // A space ends the token — selection inserts the full (spaced) name for us.
  if (/\s/.test(query)) return null
  return { start: at, query }
}

export function MentionTextarea({
  value,
  onChange,
  people,
  id,
  rows,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  people: MentionPerson[]
  id?: string
  rows?: number
  placeholder?: string
  className?: string
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const [active, setActive] = React.useState<ActiveQuery | null>(null)
  const [highlight, setHighlight] = React.useState(0)
  const caretToRestore = React.useRef<number | null>(null)

  const matches = React.useMemo(() => {
    if (!active) return []
    const q = active.query.toLowerCase()
    return people
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 6)
  }, [active, people])

  const open = active !== null && matches.length > 0

  // Restore the caret after a programmatic value change (mention insertion).
  React.useEffect(() => {
    if (caretToRestore.current != null && ref.current) {
      const pos = caretToRestore.current
      caretToRestore.current = null
      ref.current.focus()
      ref.current.setSelectionRange(pos, pos)
    }
  }, [value])

  function refreshActive() {
    const el = ref.current
    if (!el) return
    const next = activeQueryAt(el.value, el.selectionStart ?? el.value.length)
    setActive(next)
    setHighlight(0)
  }

  function selectPerson(person: MentionPerson) {
    const el = ref.current
    if (!el || !active) return
    const caret = el.selectionStart ?? value.length
    const insert = `@${person.name} `
    const next = value.slice(0, active.start) + insert + value.slice(caret)
    caretToRestore.current = active.start + insert.length
    setActive(null)
    onChange(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlight((h) => (h + 1) % matches.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlight((h) => (h - 1 + matches.length) % matches.length)
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      selectPerson(matches[highlight])
    } else if (e.key === "Escape") {
      e.preventDefault()
      setActive(null)
    }
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        id={id}
        rows={rows}
        placeholder={placeholder}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          // Recompute against the just-typed value/caret.
          requestAnimationFrame(refreshActive)
        }}
        onClick={refreshActive}
        onKeyUp={(e) => {
          // Arrow/caret moves that aren't handled by keydown above.
          if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
            refreshActive()
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Delay so a click on a suggestion registers first.
          window.setTimeout(() => setActive(null), 120)
        }}
      />

      {open ? (
        <ul
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-52 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
        >
          {matches.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                // onMouseDown (not onClick) so it fires before the textarea blur.
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectPerson(p)
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm",
                  i === highlight && "bg-accent text-accent-foreground",
                )}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
