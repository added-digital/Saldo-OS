import { Suspense } from "react"

import { EngagementsBoard } from "@/components/app/engagements-board"

export default function EngagementsPage() {
  return (
    <Suspense>
      <EngagementsBoard />
    </Suspense>
  )
}
