"use client";

import { useRouter } from "next/navigation";
import { Menu, LogOut, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useUser } from "@/hooks/use-user";
import { useLanguage } from "@/hooks/use-language";
import { useTranslation } from "@/hooks/use-translation";
import { createClient } from "@/lib/supabase/client";
import { UserAvatar } from "@/components/app/user-avatar";
import { FlagGB, FlagSE } from "@/components/ui/flag";
import { SegmentationAlert } from "@/components/app/segmentation-alert";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { useSidebar } from "@/components/layout/sidebar";

interface TopbarProps {
  className?: string;
}

function Topbar({ className }: TopbarProps) {
  const { user } = useUser();
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();
  const { setMobileOpen } = useSidebar();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header
      className={cn(
        "flex h-14 items-center gap-4 border-b bg-background px-6",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setMobileOpen(true)}
      >
        <Menu className="size-5" />
        <span className="sr-only">{t("common.openMenu", "Open menu")}</span>
      </Button>

      <Breadcrumbs className="min-w-0 flex-1" />

      <SegmentationAlert />

      <Separator orientation="vertical" className="h-6" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2 px-2">
            <UserAvatar
              name={user?.full_name}
              avatarUrl={user?.avatar_url}
              size="sm"
            />
            <span className="hidden text-sm font-medium md:inline-block">
              {user?.full_name || user?.email || t("common.user", "User")}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{user?.full_name || t("common.user", "User")}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => router.push("/settings/profile")}>
              <User />
              {t("common.profile", "Profile")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("common.language", "Language")}</p>
            <div className="mt-1.5 flex items-center justify-between rounded-full border bg-muted/40 p-1">
              <button
                type="button"
                className={cn(
                  "flex h-7 w-9 items-center justify-center rounded-full transition-colors",
                  language === "sv"
                    ? "bg-background ring-1 ring-border"
                    : "opacity-60 hover:opacity-100",
                )}
                onClick={() => setLanguage("sv")}
                aria-label={t("common.switchToSwedish", "Switch to Swedish")}
              >
                <FlagSE />
              </button>
              <span className="px-2 text-[11px] font-semibold uppercase tracking-wide">
                {language === "sv" ? "SV" : "EN"}
              </span>
              <button
                type="button"
                className={cn(
                  "flex h-7 w-9 items-center justify-center rounded-full transition-colors",
                  language === "en"
                    ? "bg-background ring-1 ring-border"
                    : "opacity-60 hover:opacity-100",
                )}
                onClick={() => setLanguage("en")}
                aria-label={t("common.switchToEnglish", "Switch to English")}
              >
                <FlagGB />
              </button>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            <LogOut />
            {t("common.signOut", "Sign out")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

export { Topbar };
