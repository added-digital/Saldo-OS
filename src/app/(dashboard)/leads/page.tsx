"use client";

import * as React from "react";
import Link from "next/link";
import { Inbox, Search, Building2, Clock, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { useCachedData } from "@/hooks/use-cached-data";

const STATUS_OPTIONS: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "archived",
  "spam",
];

const STATUS_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  archived: "Archived",
  spam: "Spam",
};

const STATUS_BADGE: Record<
  WebsiteLeadStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  new: "default",
  contacted: "secondary",
  archived: "outline",
  spam: "destructive",
};

function formatDate(value: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type LeadsPayload = { leads: WebsiteLead[] };

export default function LeadsPage() {
  const { user } = useUser();
  const { t } = useTranslation();
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<
    WebsiteLeadStatus | "all"
  >("all");

  const fetchLeads = React.useCallback(async (): Promise<LeadsPayload> => {
    const response = await fetch("/api/leads", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as {
      leads?: WebsiteLead[];
      error?: string;
    } | null;
    if (!response.ok) {
      toast.error(payload?.error ?? t("leads.toast.loadFailed", "Failed to load leads"));
      return { leads: [] };
    }
    return { leads: payload?.leads ?? [] };
  }, [t]);

  const { data, loading, refreshing } = useCachedData<LeadsPayload>({
    key: `leads.v1.${user.id}`,
    fetcher: fetchLeads,
    staleMs: 60000,
  });

  const leads = React.useMemo(() => data?.leads ?? [], [data]);

  const filteredLeads = React.useMemo(() => {
    let result = leads;
    if (statusFilter !== "all") {
      result = result.filter((lead) => lead.status === statusFilter);
    }
    if (search) {
      const query = search.toLowerCase();
      result = result.filter((lead) =>
        [lead.name, lead.company, lead.email ?? "", lead.message]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    return result;
  }, [leads, statusFilter, search]);

  const newCount = React.useMemo(
    () => leads.filter((lead) => lead.status === "new").length,
    [leads],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("leads.searchPlaceholder", "Search leads...")}
            className="pl-9"
          />
        </div>
        <div className="ml-auto">
          <Select
            value={statusFilter}
            onValueChange={(value) =>
              setStatusFilter(value as WebsiteLeadStatus | "all")
            }
          >
            <SelectTrigger className="h-9 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("leads.filter.all", "All statuses")}
              </SelectItem>
              {STATUS_OPTIONS.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`leads.status.${status}`, STATUS_LABEL[status])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("leads.showing", "Showing")} {filteredLeads.length}{" "}
        {t("leads.of", "of")} {leads.length} {t("leads.leads", "leads")}
        {newCount > 0 ? ` · ${newCount} ${t("leads.new", "new")}` : ""}
      </p>

      {loading || (refreshing && filteredLeads.length === 0) ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-20 animate-pulse rounded-lg border bg-muted"
            />
          ))}
        </div>
      ) : filteredLeads.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("leads.empty.title", "No leads")}
          description={t(
            "leads.empty.description",
            "Leads submitted on the website will appear here.",
          )}
        />
      ) : (
        <div className="space-y-2">
          {filteredLeads.map((lead) => (
            <Link key={lead.id} href={`/leads/${lead.id}`} className="block">
              <Card className="flex flex-row items-center gap-4 p-4 transition-colors hover:bg-muted/50">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{lead.name}</span>
                    <Badge
                      variant={STATUS_BADGE[lead.status]}
                      className="shrink-0"
                    >
                      {t(`leads.status.${lead.status}`, STATUS_LABEL[lead.status])}
                    </Badge>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Building2 className="size-3.5 shrink-0" />
                    <span className="truncate">{lead.company}</span>
                  </p>
                  <p className="line-clamp-1 text-sm text-muted-foreground">
                    {lead.message}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                  <Clock className="size-3.5" />
                  {formatDate(lead.submitted_at ?? lead.created_at)}
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
