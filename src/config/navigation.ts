import {
  House,
  Users,
  UserRound,
  MailCheck,
  History,
  Settings,
  BarChart3,
  Calculator,
  Target,
  ClipboardList,
  Inbox,
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
      // Inbound website contact-form submissions (POST /api/leads/intake).
      { label: "Leads", href: "/leads", icon: Inbox },
      // Bokslut + INK2 workflow board (replaces the Effektivitet Excel tracker).
      { label: "Bokslut", href: "/bokslut", icon: ClipboardList, scope: "customers" },
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
      // EBIT, kassalikviditet, soliditet). Admin-only for now — opens up to
      // wider roles once the page handles per-portfolio filtering cleanly.
      { label: "Key Metrics", href: "/key-metrics", icon: Calculator, minRole: "admin" },
      // Träfflista — financial warnings/opportunities scoped from synced SIE
      // files (e.g. share capital reduction candidates). Admin-only like Key
      // Metrics; both read the SIE tables guarded by RLS.
      { label: "Hit list", href: "/hit-list", icon: Target, minRole: "admin" },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Settings", href: "/settings", icon: Settings, minRole: "user" },
    ],
  },
]
