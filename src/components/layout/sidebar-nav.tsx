"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { system } from "@/config/system";
import { navigation, type NavItem } from "@/config/navigation";
import { useUser } from "@/hooks/use-user";
import { useUserScopes } from "@/hooks/use-scope";
import { useTranslation } from "@/hooks/use-translation";
import { useSidebar } from "@/components/layout/sidebar";
import { NavLink } from "@/components/app/nav-link";

/**
 * Returns true if `pathname` falls under `href` — exact match OR a sub-route.
 * "/" only ever matches itself; everything else also matches `${href}/...`.
 */
function pathMatchesHref(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface SidebarNavProps {
  className?: string;
}

function isItemVisible(
  item: NavItem,
  userRole: string | undefined,
  scopes: string[],
): boolean {
  if (item.href === "/reports" || item.href === "/settings") {
    return true;
  }

  if (item.minRole) {
    const roleLevel: Record<string, number> = {
      user: 1,
      team_lead: 2,
      admin: 3,
    };
    const userLevel = roleLevel[userRole ?? "user"] ?? 1;
    const requiredLevel = roleLevel[item.minRole] ?? 1;
    if (userLevel < requiredLevel) return false;
  }

  if (item.scope) {
    if (userRole === "admin") return true;
    if (!scopes.includes(item.scope)) return false;
  }

  return true;
}

function SidebarNav({ className }: SidebarNavProps) {
  const { user } = useUser();
  const { t } = useTranslation();
  const { scopes } = useUserScopes();
  const { collapsed } = useSidebar();
  const pathname = usePathname();

  // Pick the single nav item whose href is the longest prefix of the current
  // pathname. Without this, "/mail/history" would highlight both "Send mail"
  // (/mail) and "Mail history" (/mail/history) because the latter starts with
  // the former. We pre-compute the winning href once per render so the loop
  // below can just compare.
  const allHrefs = navigation.flatMap((section) =>
    section.items.map((item) => item.href),
  );
  const activeHref = allHrefs
    .filter((href) => pathMatchesHref(pathname, href))
    .reduce<string | null>(
      (best, href) =>
        best === null || href.length > best.length ? href : best,
      null,
    );

  function translateSectionTitle(title: string): string {
    const keyByTitle: Record<string, string> = {
      Management: "navigation.sections.management",
      Mail: "navigation.sections.mail",
      Analytics: "navigation.sections.analytics",
      Administration: "navigation.sections.administration",
    };

    const key = keyByTitle[title];
    return key ? t(key, title) : title;
  }

  function translateItemLabel(label: string): string {
    const keyByLabel: Record<string, string> = {
      Home: "navigation.items.home",
      Customers: "navigation.items.customers",
      Contacts: "navigation.items.contacts",
      Bokslut: "navigation.items.engagements",
      "Send mail": "navigation.items.sendMail",
      "Mail history": "navigation.items.mailHistory",
      "Mail tracking": "navigation.items.mailTracking",
      Reports: "navigation.items.reports",
      "Key Metrics": "navigation.items.keyMetrics",
      "Hit list": "navigation.items.hitList",
      Settings: "navigation.items.settings",
    };

    const key = keyByLabel[label];
    return key ? t(key, label) : label;
  }

  return (
    <div className={cn("flex flex-1 flex-col", className)}>
      <div
        className={cn(
          "flex items-center border-b px-4 py-4 h-14",
          collapsed && "justify-center px-2",
        )}
      >
        <Image
          src={collapsed ? system.logoMark : system.logo}
          alt={system.name}
          width={collapsed ? 28 : 120}
          height={28}
          className="h-7 w-auto"
          priority
        />
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navigation.map((section, sectionIndex) => {
          const visibleItems = section.items.filter((item) =>
            isItemVisible(item, user?.role, scopes),
          );

          if (visibleItems.length === 0) return null;

          return (
            <div key={sectionIndex} className="space-y-1">
              {section.title && !collapsed && (
                <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {translateSectionTitle(section.title)}
                </p>
              )}
              {collapsed && section.title && sectionIndex > 0 && (
                <div className="mx-2 my-2 h-px bg-border" />
              )}
              {visibleItems.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  label={translateItemLabel(item.label)}
                  collapsed={collapsed}
                  badge={item.badge}
                  active={item.href === activeHref}
                />
              ))}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

export { SidebarNav };
