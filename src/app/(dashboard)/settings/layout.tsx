"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { User, Shield, UserCog, Link2, Tags, RefreshCw, Mail, FolderOpen, Database, BarChart3 } from "lucide-react"
import { type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/app/page-header"
import { useUser } from "@/hooks/use-user"
import { useTranslation } from "@/hooks/use-translation"

interface SettingsTab {
  label: string
  href: string
  icon: LucideIcon
}

function getSettingsTabs(t: (key: string, fallback?: string) => string): SettingsTab[] {
  return [
    { label: t("settings.tabs.profile", "Profile"), href: "/settings/profile", icon: User },
    { label: t("settings.tabs.users", "Users"), href: "/settings/users", icon: Shield },
    { label: t("settings.tabs.teams", "Teams"), href: "/settings/teams", icon: UserCog },
    { label: t("settings.tabs.segments", "Segments"), href: "/settings/segments", icon: Tags },
    { label: t("settings.tabs.integrations", "Integrations"), href: "/settings/integrations", icon: Link2 },
    { label: t("settings.tabs.files", "Files"), href: "/settings/files", icon: FolderOpen },
    { label: t("settings.tabs.mailTemplates", "Mail Templates"), href: "/settings/mail", icon: Mail },
    { label: t("settings.tabs.sie", "SIE"), href: "/settings/sie", icon: Database },
    { label: t("settings.tabs.sync", "Sync"), href: "/settings/sync", icon: RefreshCw },
    { label: t("settings.tabs.usage", "Usage"), href: "/settings/usage", icon: BarChart3 },
  ]
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { isAdmin } = useUser()
  const { t } = useTranslation()

  const settingsTabs = React.useMemo(() => getSettingsTabs(t), [t])

  const visibleTabs = isAdmin
    ? settingsTabs
    : settingsTabs.filter((tab) => tab.href === "/settings/profile")

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.header.title", "Settings")}
        description={t("settings.header.description", "Manage your account and system configuration")}
      />

      <div className="border-b">
        <nav
          className="-mb-px flex gap-4"
          aria-label={t("settings.navigation.ariaLabel", "Settings navigation")}
        >
          {visibleTabs.map((tab) => {
            const isActive =
              pathname === tab.href || pathname.startsWith(tab.href + "/")

            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "flex items-center gap-2 border-b-2 px-1 pb-3 pt-2 text-sm font-medium transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                <tab.icon className="size-4" />
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </div>

      {children}
    </div>
  )
}
