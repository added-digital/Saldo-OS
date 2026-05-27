import {
  House,
  Users,
  UserRound,
  MailCheck,
  History,
  Settings,
  BarChart3,
  Calculator,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  scope?: string
  minRole?: "admin" | "team_lead" | "user"
  badge?: "new" | "beta"
  children?: NavItem[]
}

export interface NavSection {
  title?: string
  items: NavItem[]
}

export const navigation: NavSection[] = [
  {
    items: [
      { label: "Home", href: "/", icon: House },
    ],
  },
  {
    title: "Management",
    items: [
      { label: "Customers", href: "/customers", icon: Users, scope: "customers" },
      { label: "Contacts", href: "/contacts", icon: UserRound },
    ],
  },
  {
    title: "Mail",
    items: [
      { label: "Send mail", href: "/mail", icon: MailCheck, scope: "customers" },
      { label: "Mail history", href: "/mail/history", icon: History, scope: "customers" },
    ],
  },
  {
    title: "Analytics",
    items: [
      { label: "Reports", href: "/reports", icon: BarChart3, minRole: "user" },
      // Financial KPIs derived from synced SIE files (revenue, gross margin,
      // EBIT, kassalikviditet, soliditet). Scoped to `customers` because
      // consultants should only see KPIs for their own portfolio.
      { label: "Key Metrics", href: "/key-metrics", icon: Calculator, scope: "customers" },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Settings", href: "/settings", icon: Settings, minRole: "user" },
    ],
  },
]
