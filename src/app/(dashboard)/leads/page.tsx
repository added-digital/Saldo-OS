"use client";

import * as React from "react";
import Link from "next/link";
import {
  Inbox,
  Search,
  Building2,
  Clock,
  ChevronRight,
  Plus,
  UserPen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { AddLeadDialog } from "@/components/app/add-lead-dialog";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { useCachedData } from "@/hooks/use-cached-data";

const STATUS_OPTIONS: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "offer_sent",
  "won",
  "lost",
  "archived",
  "spam",
];

const STATUS_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  offer_sent: "Offer sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
  spam: "Spam",
};

const STATUS_BADGE: Record<
  WebsiteLeadStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  new: "default",
  contacted: "secondary",
  offer_sent: "secondary",
  won: "default",
  lost: "outline",
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
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<WebsiteLead | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);

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

  const { data, loading, refreshing, setData, refresh } =
    useCachedData<LeadsPayload>({
      key: `leads.v1.${user.id}`,
      fetcher: fetchLeads,
      staleMs: 60000,
    });

  const handleCreated = React.useCallback(
    (lead: WebsiteLead) => {
      setData((prev) => ({ leads: [lead, ...(prev?.leads ?? [])] }));
      void refresh();
    },
    [setData, refresh],
  );

  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const supabase = createClient();
    // Empty result + no error = RLS blocked the delete (policy not applied).
    const { data: deleted, error } = await supabase
      .from("website_leads")
      .delete()
      .eq("id", deleteTarget.id)
      .select("id");
    setDeleting(false);
    if (error || !deleted?.length) {
      toast.error(t("leads.detail.deleteFailed", "Failed to delete lead"));
      return;
    }
    setData((prev) => ({
      leads: (prev?.leads ?? []).filter((l) => l.id !== deleteTarget.id),
    }));
    setDeleteTarget(null);
    toast.success(t("leads.detail.deleted", "Lead deleted"));
  }, [deleteTarget, setData, t]);

  const leads = React.useMemo(() => data?.leads ?? [], [data]);

  const filteredLeads = React.useMemo(() => {
    let result = leads;
    if (statusFilter !== "all") {
      result = result.filter((lead) => lead.status === statusFilter);
    }
    if (search) {
      const query = search.toLowerCase();
      result = result.filter((lead) =>
        [
          lead.name,
          lead.company,
          lead.email ?? "",
          lead.message,
          lead.org_number ?? "",
        ]
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

  const statusCounts = React.useMemo(() => {
    const counts = {} as Record<WebsiteLeadStatus, number>;
    for (const status of STATUS_OPTIONS) counts[status] = 0;
    for (const lead of leads) {
      if (lead.status in counts) counts[lead.status] += 1;
    }
    return counts;
  }, [leads]);

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
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t("leads.add.button", "Add lead")}
          </Button>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="tablist"
        aria-label={t("leads.filter.label", "Filter by status")}
      >
        {(["all", ...STATUS_OPTIONS] as const).map((status) => {
          const active = statusFilter === status;
          const count =
            status === "all" ? leads.length : statusCounts[status];
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatusFilter(status)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                active
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {status === "all"
                ? t("leads.filter.all", "All statuses")
                : t(`leads.status.${status}`, STATUS_LABEL[status])}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  active ? "bg-primary-foreground/20" : "bg-muted",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <AddLeadDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={handleCreated}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("leads.detail.deleteTitle", "Delete this lead?")}
        description={t(
          "leads.detail.deleteDescription",
          "The lead and its activity history will be permanently deleted.",
        )}
        confirmLabel={t("leads.detail.delete", "Delete lead")}
        cancelLabel={t("common.cancel", "Cancel")}
        variant="destructive"
        onConfirm={handleDelete}
        loading={deleting}
      />

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
              <Card className="group flex flex-row items-center gap-4 p-4 transition-colors hover:bg-muted/50">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{lead.name}</span>
                    <Badge
                      variant={STATUS_BADGE[lead.status]}
                      className="shrink-0"
                    >
                      {t(`leads.status.${lead.status}`, STATUS_LABEL[lead.status])}
                    </Badge>
                    {lead.source === "manual" ? (
                      <Badge variant="outline" className="shrink-0 gap-1 font-normal">
                        <UserPen className="size-3" />
                        {t("leads.source.manual", "Manual")}
                      </Badge>
                    ) : null}
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t("leads.detail.delete", "Delete lead")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDeleteTarget(lead);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
