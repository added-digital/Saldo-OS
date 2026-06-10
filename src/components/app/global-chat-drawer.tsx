"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ChevronUp, Maximize2, Minus, Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"
import { DashboardAskQuestion } from "@/components/app/dashboard-ask-question"

// Three docked states for the global assistant drawer:
//   peek    – tucked away, only the title strip shows under the header.
//   default – the everyday size; "most of it" is visible without taking over.
//   full    – pressed-open, ~70% of the viewport height.
// Heights are intentionally simple constants so they're easy to tune.
type DrawerView = "peek" | "default" | "full"

const VIEW_HEIGHTS: Record<DrawerView, string> = {
  peek: "2.75rem",
  default: "52vh",
  full: "72vh",
}

const VIEW_STORAGE_KEY = "saldo.chat.drawer-view"

// Shared transition so the drawer and the page content offset animate in lockstep.
const DRAWER_TRANSITION =
  "transition-[height,padding-top] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"

// Routes where the drawer should NOT appear. "/" already renders the
// full-page assistant, and "/settings/*" is excluded per product request.
function isExcludedRoute(pathname: string | null): boolean {
  if (!pathname) return true
  if (pathname === "/") return true
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return true
  return false
}

type ChatDrawerContextValue = {
  view: DrawerView
  setView: React.Dispatch<React.SetStateAction<DrawerView>>
  /** Effective docked height — "0px" when the drawer is hidden on this route. */
  height: string
  /** Whether the drawer renders on the current route. */
  visible: boolean
}

const ChatDrawerContext = React.createContext<ChatDrawerContextValue | null>(null)

function useChatDrawer() {
  const context = React.useContext(ChatDrawerContext)
  if (!context) {
    throw new Error("useChatDrawer must be used within a ChatDrawerProvider")
  }
  return context
}

export function ChatDrawerProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [view, setView] = React.useState<DrawerView>("default")
  const [hydrated, setHydrated] = React.useState(false)

  // Restore the last view once on mount (avoids SSR/client mismatch).
  React.useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (stored === "peek" || stored === "default" || stored === "full") {
      setView(stored)
    }
    setHydrated(true)
  }, [])

  React.useEffect(() => {
    if (!hydrated) return
    window.localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view, hydrated])

  const visible = !isExcludedRoute(pathname)
  const height = visible ? VIEW_HEIGHTS[view] : "0px"

  const value = React.useMemo<ChatDrawerContextValue>(
    () => ({ view, setView, height, visible }),
    [view, height, visible],
  )

  return (
    <ChatDrawerContext.Provider value={value}>
      {children}
    </ChatDrawerContext.Provider>
  )
}

/**
 * Wraps the page content in <main> and pushes it down by the drawer's current
 * height so toolbars and page chrome are never hidden behind the drawer —
 * even when it's collapsed to the peek strip. Animates in sync with the drawer.
 */
export function ChatDrawerMain({ children }: { children: React.ReactNode }) {
  const { height } = useChatDrawer()
  return (
    <main
      className={cn("flex-1 overflow-y-auto p-6", DRAWER_TRANSITION)}
      // Keep the normal p-6 top breathing room *below* the drawer.
      style={{ paddingTop: `calc(${height} + 1.5rem)` }}
    >
      {children}
    </main>
  )
}

export function GlobalChatDrawer() {
  const { t } = useTranslation()
  const { view, setView, height, visible } = useChatDrawer()

  if (!visible) {
    return null
  }

  const isOpen = view !== "peek"

  // Clicking the title strip is the primary "press to expand" gesture:
  // peek → default → full → default.
  function handleStripClick() {
    setView((current) =>
      current === "peek" ? "default" : current === "default" ? "full" : "default",
    )
  }

  return (
    <div
      className={cn(
        "absolute inset-x-0 top-14 z-40 flex flex-col overflow-hidden",
        "border-b border-border bg-background shadow-lg",
        DRAWER_TRANSITION,
        "rounded-b-xl",
      )}
      style={{ height }}
      aria-label={t("dashboard.chat.drawer", "Saldo OS assistant")}
    >
      {/* Title strip — clickable to expand/collapse */}
      <button
        type="button"
        onClick={handleStripClick}
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4 text-left transition-colors hover:bg-muted/40"
        aria-expanded={isOpen}
      >
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-medium text-foreground">
          {t("dashboard.chat.title", "Saldo OS")}
        </span>
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {t("dashboard.home.beta", "Beta")}
        </Badge>

        <span className="ml-auto flex items-center gap-1">
          {isOpen ? (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  setView((current) => (current === "full" ? "default" : "full"))
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    event.stopPropagation()
                    setView((current) => (current === "full" ? "default" : "full"))
                  }
                }}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={
                  view === "full"
                    ? t("dashboard.chat.restore", "Restore size")
                    : t("dashboard.chat.expand", "Expand")
                }
              >
                <Maximize2 className="size-3.5" />
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  setView("peek")
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    event.stopPropagation()
                    setView("peek")
                  }
                }}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t("dashboard.chat.minimize", "Minimize")}
              >
                <Minus className="size-3.5" />
              </span>
            </>
          ) : (
            <ChevronUp className="size-4 rotate-180 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Chat body — reuses the existing assistant. Kept mounted so the
          conversation state survives peek/expand toggles; clipped when
          peeking. */}
      <div
        className={cn(
          "min-h-0 flex-1",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden={!isOpen}
      >
        <DashboardAskQuestion customers={[]} users={[]} />
      </div>
    </div>
  )
}
