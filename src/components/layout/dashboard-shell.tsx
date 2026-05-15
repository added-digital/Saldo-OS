"use client"

import type { Profile } from "@/types/database"
import { UserProvider } from "@/hooks/use-user"
import { SyncProvider } from "@/hooks/use-sync"
import { SidebarProvider, Sidebar } from "@/components/layout/sidebar"
import { SidebarNav } from "@/components/layout/sidebar-nav"
import { Topbar } from "@/components/layout/topbar"
import { FeedbackWidget } from "@/components/app/feedback-widget"

function DashboardShell({
  profile,
  children,
}: {
  profile: Profile
  children: React.ReactNode
}) {
  return (
    <UserProvider profile={profile}>
      <SyncProvider>
        <SidebarProvider>
          <div className="flex h-screen overflow-hidden">
            <Sidebar>
              <SidebarNav />
            </Sidebar>
            <div className="flex flex-1 flex-col overflow-hidden">
              <Topbar />
              <main className="flex-1 overflow-y-auto p-6">
                {children}
              </main>
            </div>
          </div>
          <FeedbackWidget />
        </SidebarProvider>
      </SyncProvider>
    </UserProvider>
  )
}

export { DashboardShell }
