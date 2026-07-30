import { Suspense } from "react"

import { TasksBoard } from "@/components/app/tasks-board"

export default function TasksPage() {
  return (
    <Suspense>
      <TasksBoard />
    </Suspense>
  )
}
