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
  BadgeCheck,
  Trash2,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/use-user";
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { AddLeadDialog } from "@/components/app/add-lead-dialog";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { LeadActivityLog } from "@/components/app/lead-activity-log";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/hooks/use-translation";

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
          <Badge variant={STATUS_BADGE[lead.status]}>
            {t(`leads.status.${lead.status}`, STATUS_LABEL[lead.status])}
          </Badge>
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
            <div className="flex items-center gap-2">
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
