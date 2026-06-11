"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { useTranslation } from "@/hooks/use-translation"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

type PendingNavigation =
  | { kind: "href"; href: string }
  | { kind: "action"; run: () => void }

interface UnsavedChangesContextValue {
  /** Register/track whether a given source currently has unsaved changes. */
  setDirty: (id: string, dirty: boolean) => void
  /** Run a programmatic navigation, guarded by the unsaved-changes prompt. */
  confirmNavigation: (action: () => void) => void
}

const UnsavedChangesContext =
  React.createContext<UnsavedChangesContextValue | null>(null)

export function useUnsavedChanges(): UnsavedChangesContextValue {
  const ctx = React.useContext(UnsavedChangesContext)
  if (!ctx) {
    throw new Error(
      "useUnsavedChanges must be used within <UnsavedChangesProvider>",
    )
  }
  return ctx
}

/**
 * Convenience hook for an editor component: reports its dirty state to the
 * provider and unregisters on unmount. Pass a stable `id` if multiple editors
 * can be dirty at once on the same screen.
 */
export function useUnsavedChangesGuard(dirty: boolean, id?: string) {
  const { setDirty } = useUnsavedChanges()
  const generatedId = React.useId()
  const sourceId = id ?? generatedId
  React.useEffect(() => {
    setDirty(sourceId, dirty)
    return () => setDirty(sourceId, false)
  }, [dirty, sourceId, setDirty])
}

/**
 * Guards navigation while any registered editor has unsaved changes:
 *  - in-app link clicks (sidebar, nav, breadcrumbs) are intercepted and prompt
 *  - programmatic navigation (e.g. a Back button) goes through `confirmNavigation`
 *  - browser refresh / tab close triggers the native `beforeunload` prompt
 *
 * Note: the browser's own Back/Forward buttons in a single-page app are only
 * covered by the native prompt on full reloads, not by the in-app dialog.
 */
export function UnsavedChangesProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const { t } = useTranslation()

  const dirtySourcesRef = React.useRef<Set<string>>(new Set())
  const [isDirty, setIsDirty] = React.useState(false)
  const isDirtyRef = React.useRef(false)
  React.useEffect(() => {
    isDirtyRef.current = isDirty
  }, [isDirty])

  const [pending, setPending] = React.useState<PendingNavigation | null>(null)

  const setDirty = React.useCallback((id: string, dirty: boolean) => {
    const set = dirtySourcesRef.current
    if (dirty) set.add(id)
    else set.delete(id)
    setIsDirty(set.size > 0)
  }, [])

  const confirmNavigation = React.useCallback((action: () => void) => {
    if (!isDirtyRef.current) {
      action()
      return
    }
    setPending({ kind: "action", run: action })
  }, [])

  // Warn on refresh / tab close (native browser prompt).
  React.useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirtyRef.current) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  // Intercept in-app link clicks (sidebar, nav links, breadcrumbs) while dirty.
  // Capture phase runs before Next's <Link> click handler, so preventing the
  // default + stopping propagation reliably cancels the client navigation.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!isDirtyRef.current) return
      if (e.defaultPrevented) return
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return
      }

      const target = e.target as Element | null
      const anchor = target?.closest?.("a")
      if (!anchor) return

      const href = anchor.getAttribute("href")
      if (!href) return
      if (anchor.target && anchor.target !== "_self") return
      if (anchor.hasAttribute("download")) return

      let url: URL
      try {
        url = new URL(href, window.location.href)
      } catch {
        return
      }
      // External links are handled by the native beforeunload prompt instead.
      if (url.origin !== window.location.origin) return

      const dest = url.pathname + url.search + url.hash
      const current =
        window.location.pathname + window.location.search + window.location.hash
      if (dest === current) return

      e.preventDefault()
      e.stopPropagation()
      setPending({ kind: "href", href: dest })
    }

    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])

  function handleLeave() {
    const nav = pending
    setPending(null)
    // Clear dirty so the imminent navigation isn't re-intercepted.
    dirtySourcesRef.current.clear()
    isDirtyRef.current = false
    setIsDirty(false)
    if (!nav) return
    if (nav.kind === "href") router.push(nav.href)
    else nav.run()
  }

  function handleStay() {
    setPending(null)
  }

  const value = React.useMemo<UnsavedChangesContextValue>(
    () => ({ setDirty, confirmNavigation }),
    [setDirty, confirmNavigation],
  )

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) handleStay()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("common.unsavedChanges.title", "Leave without saving?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "common.unsavedChanges.description",
                "You have unsaved changes. If you leave now, they will be lost.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleStay}>
              {t("common.unsavedChanges.stay", "Stay")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleLeave}>
              {t("common.unsavedChanges.leave", "Leave without saving")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  )
}
