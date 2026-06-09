"use client";

import * as React from "react";
import NumberFlow from "@number-flow/react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { Users, UserCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { type LucideIcon } from "lucide-react";

import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { getRoleLabel } from "@/lib/utils";

// ── Shapes returned by /api/usage/summary ────────────────────────────────────
interface UsageSummary {
  generatedAt: string;
  activeUsers: {
    total: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
  lastSeen: Array<{
    id: string;
    name: string | null;
    email: string | null;
    role: string | null;
    is_active: boolean | null;
    last_sign_in_at: string | null;
  }>;
  newUsersByMonth: Array<{ month: string; count: number }>;
  recordCounts: Record<string, number | null>;
}

const activeChartConfig = {
  count: { label: "Active users", color: "var(--chart-1)" },
} satisfies ChartConfig;

const signupChartConfig = {
  count: { label: "New users", color: "var(--chart-2)" },
} satisfies ChartConfig;

// Shared bar styling so the two charts read as a matched pair — same pillar
// width, corner radius and top margin regardless of how many bars each has.
const BAR_SIZE = 40;
const BAR_RADIUS = 4;
const CHART_MARGIN = { top: 20 } as const;

// How many users per page in the "Last activity" table.
const LAST_SEEN_PAGE_SIZE = 10;

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
}) {
  return (
    <Card className="gap-2">
      <CardHeader className="p-6 pb-1 pt-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 pt-0 pb-0">
        <p className="text-2xl font-semibold leading-tight">
          {value === null ? (
            "—"
          ) : (
            <NumberFlow value={value} locales="sv-SE" />
          )}
        </p>
      </CardContent>
    </Card>
  );
}

export default function UsagePage() {
  const { isAdmin } = useUser();
  const { t } = useTranslation();
  const [data, setData] = React.useState<UsageSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/usage/summary");
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        const json = (await res.json()) as UsageSummary;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isAdmin) {
    return null;
  }

  const activeChartData = data
    ? [
        { window: t("usage.window.daily", "Today"), count: data.activeUsers.daily },
        { window: t("usage.window.weekly", "7 days"), count: data.activeUsers.weekly },
        { window: t("usage.window.monthly", "30 days"), count: data.activeUsers.monthly },
      ]
    : [];

  // Client-side pagination for the last-activity table.
  const lastSeen = data?.lastSeen ?? [];
  const pageCount = Math.max(1, Math.ceil(lastSeen.length / LAST_SEEN_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedLastSeen = lastSeen.slice(
    currentPage * LAST_SEEN_PAGE_SIZE,
    currentPage * LAST_SEEN_PAGE_SIZE + LAST_SEEN_PAGE_SIZE
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("usage.header.title", "Usage")} />

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-semantic-error">
            {error}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Active users ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] w-full" />
          ))
        ) : (
          <>
            <StatCard
              icon={Users}
              label={t("usage.stat.totalUsers", "Total users")}
              value={data.activeUsers.total}
            />
            <StatCard
              icon={UserCheck}
              label={t("usage.stat.activeToday", "Active today")}
              value={data.activeUsers.daily}
            />
            <StatCard
              icon={UserCheck}
              label={t("usage.stat.activeWeek", "Active this week")}
              value={data.activeUsers.weekly}
            />
            <StatCard
              icon={UserCheck}
              label={t("usage.stat.activeMonth", "Active this month")}
              value={data.activeUsers.monthly}
            />
          </>
        )}
      </div>

      {/* ── Charts ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t("usage.chart.activeByWindow", "Active users by window")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !data ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (
              <ChartContainer config={activeChartConfig} className="h-[240px] w-full">
                <BarChart accessibilityLayer data={activeChartData} margin={CHART_MARGIN}>
                  <CartesianGrid vertical={false} className="stroke-muted-foreground/20" />
                  <XAxis dataKey="window" tickLine={false} tickMargin={10} axisLine={false} />
                  <YAxis hide />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={BAR_RADIUS} barSize={BAR_SIZE}>
                    <LabelList position="top" offset={8} className="fill-foreground" fontSize={12} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t("usage.chart.newUsers", "New users per month")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !data ? (
              <Skeleton className="h-[240px] w-full" />
            ) : data.newUsersByMonth.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("usage.chart.noData", "Not enough data yet.")}
              </p>
            ) : (
              <ChartContainer config={signupChartConfig} className="h-[240px] w-full">
                <BarChart accessibilityLayer data={data.newUsersByMonth} margin={CHART_MARGIN}>
                  <CartesianGrid vertical={false} className="stroke-muted-foreground/20" />
                  <XAxis dataKey="month" tickLine={false} tickMargin={10} axisLine={false} />
                  <YAxis hide />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={BAR_RADIUS} barSize={BAR_SIZE}>
                    <LabelList position="top" offset={8} className="fill-foreground" fontSize={12} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Last seen per user ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {t("usage.section.lastSeen", "Last activity per user")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading || !data ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">{t("usage.table.name", "Name")}</TableHead>
                  <TableHead className="w-[34%]">{t("usage.table.email", "Email")}</TableHead>
                  <TableHead className="w-[18%]">{t("usage.table.role", "Role")}</TableHead>
                  <TableHead className="w-[20%] text-right">
                    {t("usage.table.lastSeen", "Last sign-in")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedLastSeen.map((u) => (
                  <TableRow key={u.id} className={u.is_active === false ? "opacity-50" : ""}>
                    <TableCell className="truncate font-medium">{u.name ?? "—"}</TableCell>
                    <TableCell className="truncate text-muted-foreground">{u.email ?? "—"}</TableCell>
                    <TableCell className="truncate">{u.role ? getRoleLabel(u.role) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {u.last_sign_in_at ? (
                        formatDateTime(u.last_sign_in_at)
                      ) : (
                        <span className="text-muted-foreground">
                          {t("usage.table.never", "Never")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!loading && data && pageCount > 1 ? (
            <div className="flex items-center justify-between pt-4">
              <p className="text-xs text-muted-foreground">
                {t("usage.table.page", "Page")} {currentPage + 1} / {pageCount}
                {" · "}
                {lastSeen.length} {t("usage.table.users", "users")}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                >
                  <ChevronLeft className="size-4" />
                  {t("common.previous", "Previous")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={currentPage >= pageCount - 1}
                >
                  {t("common.next", "Next")}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {data ? (
        <p className="text-xs text-muted-foreground">
          {t("usage.generatedAt", "Generated")} {formatDateTime(data.generatedAt)}
          {" · "}
          {t(
            "usage.trendNote",
            "Active-user history needs Phase 1 event tracking — we only know each user's last sign-in today."
          )}
        </p>
      ) : null}
    </div>
  );
}
