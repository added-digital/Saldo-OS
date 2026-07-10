"use client";

import * as React from "react";
import { use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Mail,
  Phone,
  Building2,
  Globe,
  Clock,
  ShieldCheck,
  Hash,
  MapPin,
  UserPen,
  UserRound,
  BadgeCheck,
  Trash2,
  Pencil,
  Check,
  ChevronsUpDown,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useUser } from "@/hooks/use-user";
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { AddLeadDialog } from "@/components/app/add-lead-dialog";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { LeadActivityLog } from "@/components/app/lead-activity-log";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useTranslation } from "@/hooks/use-translation";

type ManagerOption = { id: string; name: string };

const STATUS_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  offer_sent: "Offer sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
  spam: "Spam",
};

/** Pipeline order for the status dropdown. */
const STATUS_ORDER: WebsiteLeadStatus[] = [
  "new",
  "contacted",
  "offer_sent",
  "won",
  "lost",
  "archived",
  "spam",
];

/** Status dot colour, so the trigger keeps its at-a-glance signal. */
const STATUS_DOT: Record<WebsiteLeadStatus, string> = {
  new: "bg-semantic-info",
  contacted: "bg-semantic-info",
  offer_sent: "bg-semantic-warning",
  won: "bg-semantic-success",
  lost: "bg-muted-foreground",
  archived: "bg-muted-foreground",
  spam: "bg-semantic-error",
};

/**
 * Patch this lead's status inside the cached /leads list (localStorage) so
 * the list badge matches immediately instead of waiting out the cache TTL.
 */
function patchLeadsCache(
  userId: string,
  leadId: string,
  status: WebsiteLeadStatus,
) {
  try {
    const key = `cache:leads.v1.${userId}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const envelope = JSON.parse(raw) as {
      value?: { leads?: WebsiteLead[] };
      cachedAt?: number;
    };
    const leads = envelope.value?.leads;
    if (!Array.isArray(leads)) return;
    envelope.value = {
      leads: leads.map((l) => (l.id === leadId ? { ...l, status } : l)),
    };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Cache patching is best-effort.
  }
}

function formatDate(value: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleString();
}

function notificationLabel(
  lead: WebsiteLead,
  t: (key: string, fallback?: string) => string,
): string {
  switch (lead.notification_status) {
    case "sent":
      return t("leads.notify.sent", "Notification sent");
    case "failed":
      return t("leads.notify.failed", "Notification failed");
    case "skipped":
      return t("leads.notify.skipped", "Email not sent");
    default:
      return t("leads.notify.pending", "Notification pending");
  }
}

export default function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useUser();
  const [lead, setLead] = React.useState<WebsiteLead | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [managers, setManagers] = React.useState<ManagerOption[]>([]);
  const [savingManager, setSavingManager] = React.useState(false);
  const [managerOpen, setManagerOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [savingStatus, setSavingStatus] = React.useState(false);
  const [activityRefresh, setActivityRefresh] = React.useState(0);

  const fetchLead = React.useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("website_leads")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      toast.error(t("leads.toast.loadFailed", "Failed to load lead"));
      setLoading(false);
      return;
    }
    if (!data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLead(data as unknown as WebsiteLead);
    setLoading(false);
  }, [id, t]);

  React.useEffect(() => {
    void fetchLead();
  }, [fetchLead]);

  // Active staff, used to populate the customer-manager picker.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .eq("is_active", true)
        .order("full_name")
        .limit(500);
      if (cancelled) return;
      setManagers(
        ((data ?? []) as Array<{
          id: string;
          full_name: string | null;
          email: string;
        }>).map((p) => ({ id: p.id, name: p.full_name ?? p.email })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the customer-manager assignment. On a real (non-self) assignment,
  // fire the notification RPC so the manager sees it in the header bell.
  async function handleManagerChange(nextId: string | null) {
    setManagerOpen(false);
    if (!lead) return;
    if (nextId === (lead.customer_manager_id ?? null)) return;

    setSavingManager(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("website_leads")
      .update({ customer_manager_id: nextId } as never)
      .eq("id", lead.id)
      .select("id");

    if (error || !data?.length) {
      setSavingManager(false);
      toast.error(
        t("leads.detail.managerFailed", "Failed to update customer manager"),
      );
      return;
    }

    setLead((prev) =>
      prev ? { ...prev, customer_manager_id: nextId } : prev,
    );

    if (nextId && nextId !== user.id) {
      await supabase.rpc("create_lead_assignment_notification" as never, {
        p_lead_id: lead.id,
        p_recipient_id: nextId,
      } as never);
    }

    setSavingManager(false);
    toast.success(
      t("leads.detail.managerUpdated", "Customer manager updated"),
    );
  }

  // Manually set the pipeline status. Status is normally activity-driven, so we
  // also log a status_change entry to keep the activity timeline truthful.
  async function handleStatusSelect(next: WebsiteLeadStatus) {
    setStatusOpen(false);
    if (!lead || next === lead.status) return;

    setSavingStatus(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("website_leads")
      .update({ status: next } as never)
      .eq("id", lead.id)
      .select("id");

    if (error || !data?.length) {
      setSavingStatus(false);
      toast.error(t("leads.detail.statusFailed", "Failed to update status"));
      return;
    }

    await supabase.from("lead_activities").insert({
      lead_id: lead.id,
      activity_type: "status_change",
      note: null,
      created_by: user.id,
    } as never);

    setLead((prev) => (prev ? { ...prev, status: next } : prev));
    patchLeadsCache(user.id, id, next);
    setActivityRefresh((n) => n + 1);
    setSavingStatus(false);
    toast.success(t("leads.detail.statusUpdated", "Status updated"));
  }

  // Status is driven by the activity log; this just reflects the change in
  // local state and the cached /leads list.
  const handleStatusChange = React.useCallback(
    (status: WebsiteLeadStatus) => {
      setLead((prev) => (prev ? { ...prev, status } : prev));
      patchLeadsCache(user.id, id, status);
    },
    [user.id, id],
  );

  const handleUpdated = React.useCallback(
    (updated: WebsiteLead) => {
      setLead(updated);
      // Company/name/etc. changed — drop the list cache so it refetches.
      try {
        window.localStorage.removeItem(`cache:leads.v1.${user.id}`);
      } catch {
        // Cache eviction is best-effort.
      }
    },
    [user.id],
  );

  async function deleteLead() {
    if (!lead) return;
    setDeleting(true);
    const supabase = createClient();
    // Empty result + no error = RLS blocked the delete (policy not applied).
    const { data, error } = await supabase
      .from("website_leads")
      .delete()
      .eq("id", lead.id)
      .select("id");
    setDeleting(false);
    if (error || !data?.length) {
      toast.error(t("leads.detail.deleteFailed", "Failed to delete lead"));
      return;
    }
    toast.success(t("leads.detail.deleted", "Lead deleted"));
    // Drop the list cache so the deleted lead doesn't linger there.
    try {
      window.localStorage.removeItem(`cache:leads.v1.${user.id}`);
    } catch {
      // Cache eviction is best-effort.
    }
    router.push("/leads");
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-9 w-48 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted" />
      </div>
    );
  }

  if (notFound || !lead) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("leads.detail.notFound", "Lead not found")} />
        <Button variant="outline" onClick={() => router.push("/leads")}>
          <ArrowLeft className="size-4" />
          {t("leads.detail.back", "Back to leads")}
        </Button>
      </div>
    );
  }

  const email = lead.email?.trim() || null;
  const phone = lead.phone?.trim() || null;
  const isManual = lead.source === "manual";
  const selectedManagerName =
    managers.find((m) => m.id === lead.customer_manager_id)?.name ?? null;
  const addressLine = [
    lead.address_street,
    [lead.address_postal_code, lead.address_city].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 gap-1.5 text-muted-foreground"
        onClick={() => router.push("/leads")}
      >
        <ArrowLeft className="size-4" />
        {t("leads.detail.back", "Back to leads")}
      </Button>

      <PageHeader title={lead.name} description={lead.company}>
        <div className="flex items-center gap-2">
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={statusOpen}
                disabled={savingStatus}
                className="h-9 justify-between gap-2 font-normal"
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT[lead.status],
                    )}
                  />
                  {t(`leads.status.${lead.status}`, STATUS_LABEL[lead.status])}
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void handleStatusSelect(s)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    s === lead.status && "bg-accent/50",
                  )}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      s === lead.status ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[s])}
                  />
                  {t(`leads.status.${s}`, STATUS_LABEL[s])}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="icon"
            aria-label={t("leads.detail.delete", "Delete lead")}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </PageHeader>

      <AddLeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead}
        onUpdated={handleUpdated}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("leads.detail.deleteTitle", "Delete this lead?")}
        description={t(
          "leads.detail.deleteDescription",
          "The lead and its activity history will be permanently deleted.",
        )}
        confirmLabel={t("leads.detail.delete", "Delete lead")}
        cancelLabel={t("common.cancel", "Cancel")}
        variant="destructive"
        onConfirm={deleteLead}
        loading={deleting}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {lead.message ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {isManual
                    ? t("leads.detail.note", "Note")
                    : t("leads.detail.message", "Message")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {lead.message}
                </p>
              </CardContent>
            </Card>
          ) : null}

          <LeadActivityLog
            leadId={lead.id}
            leadStatus={lead.status}
            onStatusChange={handleStatusChange}
            refreshToken={activityRefresh}
          />
        </div>

        <Card className="self-start">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">
                {t("leads.detail.details", "Details")}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("leads.detail.edit", "Edit lead")}
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-muted-foreground">
                <UserRound className="size-4 shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wide">
                  {t("leads.detail.customerManager", "Customer manager")}
                </span>
              </div>
              <Popover open={managerOpen} onOpenChange={setManagerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={managerOpen}
                    disabled={savingManager}
                    className="w-full justify-between font-normal"
                  >
                    <span
                      className={cn(
                        "truncate",
                        !selectedManagerName && "text-muted-foreground",
                      )}
                    >
                      {selectedManagerName ??
                        t("leads.detail.unassigned", "Unassigned")}
                    </span>
                    <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[--radix-popover-trigger-width] p-0"
                >
                  <Command>
                    <CommandInput
                      placeholder={t(
                        "leads.detail.managerSearch",
                        "Search people…",
                      )}
                    />
                    <CommandList className="max-h-[260px]">
                      <CommandEmpty>
                        {t("leads.detail.managerNoResults", "No people found.")}
                      </CommandEmpty>
                      <CommandItem
                        value={t("leads.detail.unassigned", "Unassigned")}
                        onSelect={() => void handleManagerChange(null)}
                      >
                        <Check
                          className={cn(
                            "size-4",
                            lead.customer_manager_id
                              ? "opacity-0"
                              : "opacity-100",
                          )}
                        />
                        {t("leads.detail.unassigned", "Unassigned")}
                      </CommandItem>
                      {managers.map((m) => (
                        <CommandItem
                          key={m.id}
                          value={m.name}
                          onSelect={() => void handleManagerChange(m.id)}
                        >
                          <Check
                            className={cn(
                              "size-4",
                              lead.customer_manager_id === m.id
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                          {m.name}
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex items-center gap-2 border-t pt-3">
              <Building2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {lead.company}
                {lead.company_legal_form ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {lead.company_legal_form}
                  </span>
                ) : null}
              </span>
            </div>
            {lead.org_number ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Hash className="size-4 shrink-0" />
                <span>{lead.org_number}</span>
                {lead.bolagsverket_data ? (
                  <BadgeCheck
                    className="size-4 shrink-0 text-semantic-success"
                    aria-label={t(
                      "leads.detail.verified",
                      "Verified via Bolagsverket",
                    )}
                  />
                ) : null}
              </div>
            ) : null}
            {addressLine ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="size-4 shrink-0" />
                <span className="truncate">{addressLine}</span>
              </div>
            ) : null}
            {lead.contact_role ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <UserPen className="size-4 shrink-0" />
                <span className="truncate">
                  {lead.name} · {lead.contact_role}
                </span>
              </div>
            ) : null}
            {email ? (
              <a
                href={`mailto:${email}`}
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Mail className="size-4 shrink-0" />
                <span className="truncate">{email}</span>
              </a>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="size-4 shrink-0" />
                <span>–</span>
              </div>
            )}
            {phone ? (
              <a
                href={`tel:${phone}`}
                className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Phone className="size-4 shrink-0" />
                <span>{phone}</span>
              </a>
            ) : null}
            {lead.page_path ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Globe className="size-4 shrink-0" />
                <span className="truncate">{lead.page_path}</span>
              </div>
            ) : null}
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="size-4 shrink-0" />
              <span>{formatDate(lead.submitted_at ?? lead.created_at)}</span>
            </div>
            {lead.recaptcha_score !== null ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" />
                <span>
                  {t("leads.detail.recaptcha", "reCAPTCHA")}: {lead.recaptcha_score}
                </span>
              </div>
            ) : null}

            {!isManual ? (
              <div className="border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  {notificationLabel(lead, t)}
                  {lead.notification_recipient
                    ? ` · ${lead.notification_recipient}`
                    : ""}
                </p>
                {lead.notification_error ? (
                  <p className="mt-1 text-xs text-destructive">
                    {lead.notification_error}
                  </p>
                ) : null}
              </div>
            ) : null}

            <Badge variant="outline" className="font-normal">
              {isManual
                ? t("leads.detail.sourceManual", "Added manually")
                : `${t("leads.detail.form", "Form")}: ${lead.form_name}`}
            </Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
