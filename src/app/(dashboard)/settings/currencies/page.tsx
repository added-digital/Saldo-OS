"use client";

import * as React from "react";
import { Coins, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { CurrencyRate } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/app/empty-state";
import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { BASE_CURRENCY, formatDateTime } from "@/lib/utils";

export default function CurrenciesPage() {
  const { isAdmin } = useUser();
  const { t } = useTranslation();
  const [rates, setRates] = React.useState<CurrencyRate[]>([]);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [savingCode, setSavingCode] = React.useState<string | null>(null);

  const fetchRates = React.useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("currency_rates")
      .select("*")
      .order("code", { ascending: true });

    if (error) {
      toast.error(t("settings.currencies.loadFailed", "Failed to load rates"));
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as unknown as CurrencyRate[];
    setRates(rows);
    setDrafts(
      Object.fromEntries(rows.map((row) => [row.code, String(row.rate_to_sek)])),
    );
    setLoading(false);
  }, [t]);

  React.useEffect(() => {
    void fetchRates();
  }, [fetchRates]);

  async function handleSave(code: string) {
    const raw = (drafts[code] ?? "").replace(",", ".").trim();
    const value = Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
      toast.error(
        t("settings.currencies.invalidRate", "Enter a rate greater than 0"),
      );
      return;
    }

    setSavingCode(code);
    const supabase = createClient();
    const { error } = await supabase
      .from("currency_rates")
      .update({ rate_to_sek: value } as never)
      .eq("code", code);
    setSavingCode(null);

    if (error) {
      toast.error(t("settings.currencies.saveFailed", "Failed to save rate"));
      return;
    }

    toast.success(t("settings.currencies.saved", "Rate updated"));
    void fetchRates();
  }

  if (!isAdmin) {
    return (
      <EmptyState
        icon={Coins}
        title={t("settings.currencies.adminOnly", "Admins only")}
        description={t(
          "settings.currencies.adminOnlyDescription",
          "Only administrators can change exchange rates.",
        )}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="size-4" />
          {t("settings.currencies.title", "Exchange rates")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            "settings.currencies.description",
            "SEK per 1 unit of each currency. Invoices keep the rate Fortnox booked them at; these rates apply to contracts and to invoices Fortnox gave no rate for. Changing a rate updates those amounts everywhere.",
          )}
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading", "Loading...")}
          </div>
        ) : (
          <div className="space-y-3">
            {rates.map((rate) => {
              const isBase = rate.code === BASE_CURRENCY;

              return (
                <div
                  key={rate.code}
                  className="flex flex-wrap items-center gap-3 rounded-md border p-3"
                >
                  <span className="w-14 text-sm font-medium">{rate.code}</span>
                  <Input
                    value={drafts[rate.code] ?? ""}
                    onChange={(event) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [rate.code]: event.target.value,
                      }))
                    }
                    disabled={isBase}
                    inputMode="decimal"
                    className="w-32"
                    aria-label={t(
                      "settings.currencies.rateLabel",
                      "SEK per 1 {code}",
                    ).replace("{code}", rate.code)}
                  />
                  <span className="text-sm text-muted-foreground">
                    {t("settings.currencies.perUnit", "kr per 1 {code}").replace(
                      "{code}",
                      rate.code,
                    )}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("settings.currencies.updated", "Updated")}{" "}
                    {formatDateTime(rate.updated_at)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      isBase ||
                      savingCode === rate.code ||
                      (drafts[rate.code] ?? "") === String(rate.rate_to_sek)
                    }
                    onClick={() => handleSave(rate.code)}
                  >
                    {savingCode === rate.code
                      ? t("common.saving", "Saving...")
                      : t("common.save", "Save")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
