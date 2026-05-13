"use client"

import * as React from "react"

const STAGING_ORIGIN = "https://staging-os.saldoredo.se"

export function DevelopmentBadge() {
  const [isVisible, setIsVisible] = React.useState(false)

  React.useEffect(() => {
    setIsVisible(window.location.origin === STAGING_ORIGIN)
  }, [])

  if (!isVisible) {
    return null
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-md border border-amber-300/70 bg-amber-400 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-amber-950 shadow-lg">
      Development
    </div>
  )
}
