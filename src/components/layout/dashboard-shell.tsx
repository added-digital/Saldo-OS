"use client"

import type { Profile } from "@/types/database"
import { UserProvider } from "@/hooks/use-user"
import { SyncProvider } from "@/hooks/use-sync"
import { SidebarProvider, Sidebar } from "@/components/layout/sidebar"
import { SidebarNav } from "@/components/layout/sidebar-nav"
import { Topbar } from "@/components/layout/topbar"
import { FeedbackWidget } from "@/components/app/feedback-widget"
import {
  ChatDrawerProvider,
  ChatDrawerMain,
  GlobalChatDrawer,
} from "@/components/app/global-chat-drawer"

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
            <ChatDrawerProvider>
              <div className="relative flex flex-1 flex-col overflow-hidden">
                <Topbar />
                <GlobalChatDrawer />
                <ChatDrawerMain>{children}</ChatDrawerMain>
              </div>
            </ChatDrawerProvider>
          </div>
          <FeedbackWidget />
        </SidebarProvider>
      </SyncProvider>
    </UserProvider>
  )
}

export { DashboardShell }
