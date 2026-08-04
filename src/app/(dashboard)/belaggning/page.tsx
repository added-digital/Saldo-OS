import { Suspense } from "react"

import { BelaggningBoard } from "@/components/app/belaggning-board"

export default function BelaggningPage() {
  return (
    <Suspense>
      <BelaggningBoard />
    </Suspense>
  )
}
