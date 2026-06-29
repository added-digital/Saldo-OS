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
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/hooks/use-translation";

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
  const [lead, setLead] = React.useState<WebsiteLead | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

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

  async function updateStatus(status: WebsiteLeadStatus) {
    if (!lead) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("website_leads")
      .update({ status } as never)
      .eq("id", lead.id);
    setSaving(false);
    if (error) {
      toast.error(t("leads.toast.updateFailed", "Failed to update lead"));
      return;
    }
    setLead({ ...lead, status });
    toast.success(t("leads.toast.updated", "Lead updated"));
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
        <Select
          value={lead.status}
          onValueChange={(value) => updateStatus(value as WebsiteLeadStatus)}
          disabled={saving}
        >
          <SelectTrigger className="h-9 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`leads.status.${status}`, STATUS_LABEL[status])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("leads.detail.message", "Message")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {lead.message}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("leads.detail.details", "Details")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Building2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{lead.company}</span>
            </div>
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

            <Badge variant="outline" className="font-normal">
              {t("leads.detail.form", "Form")}: {lead.form_name}
            </Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
