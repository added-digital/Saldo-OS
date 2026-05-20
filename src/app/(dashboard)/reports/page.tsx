"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  Filter,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/use-user";
import type {
  ContractAccrual,
  Customer,
  CustomerWithRelations,
  Profile,
} from "@/types/database";
import { EmptyState } from "@/components/app/empty-state";
import { DataTable } from "@/components/app/data-table";
import { KpiCards } from "@/components/app/kpi-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";
import {
  REPORTS_MANAGER_ALIAS,
  REPORT_MONTH_OPTIONS_COUNT,
  TIME_REPORTS_PAGE_SIZE,
  FETCH_ALL_PAGE_SIZE,
  MONTHLY_UNMAPPED_ARTICLE_GROUP,
  MONTHLY_DEFAULT_EXCLUDED_ARTICLE_GROUP,
  isInternalFortnoxCustomer,
  REPORTS_FILTERS_STORAGE_KEY,
  turnoverChartConfig,
  parseSavedReportsFilters,
  sekFormatter,
  hoursFormatter,
  formatSwedishMonthShort,
  formatSwedishMonthYear,
  normalizeText,
  normalizeIdentifier,
  getInitials,
  toPossessive,
  toPossessiveLabel,
  prefixFilterScore,
  getNiceStep,
  getRoundedChartMax,
  chunkArray,
  toMonthKey,
  toDateKey,
  parseMonthKey,
  createMonthOptions,
  getPreviousReportingWindowRange,
  getReportingWindowRange,
  getMonthDateRange,
  getDefaultReportsMonthKey,
  compareMonthKeys,
  compareMonthKeysWithAverageFixed,
  mapInvoicesToDetailRows,
  createEmptyTurnoverRows,
  metricLabel,
  matchesMetric,
  createEmptyMonthlyTimeReportingRows,
  annualizeContractTotal,
} from "@/lib/reports";
import type {
  ComparisonMode,
  ReportingWindowMode,
  RollingMonth,
  SavedReportsFilters,
  TeamOption,
  ManagerOption,
  SelectOption,
  SearchSelectProps,
  MonthlyTimeReportingRow,
  CustomerTimeReportingRow,
  HelpedCustomerManagerRow,
  CustomerMonthlyEconomicsRow,
  ManagerCustomerSummaryRow,
  ArticleGroupItemRow,
  ArticleGroupSummaryRow,
  TurnoverMonthRow,
  MonthlyInvoiceGroupRow,
  MonthlyHourGroupRow,
  TimeDetailMetric,
  TimeDetailRow,
  InvoiceDetailRow,
  InvoiceDetailSource,
  TurnoverTooltipPayloadItem,
} from "@/lib/reports";

async function fetchAllPages<T>(
  buildQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(
      offset,
      offset + FETCH_ALL_PAGE_SIZE - 1,
    );
    if (error) throw error;
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < FETCH_ALL_PAGE_SIZE) break;
    offset += FETCH_ALL_PAGE_SIZE;
  }

  return all;
}

function TurnoverTooltipContent({
  active,
  payload,
  label,
  turnoverLabel = "Turnover",
  invoicesLabel = "Invoices",
  previousLabel = "Previous period",
}: {
  active?: boolean;
  payload?: TurnoverTooltipPayloadItem[];
  label?: string | number;
  turnoverLabel?: string;
  invoicesLabel?: string;
  previousLabel?: string;
}) {
  if (!active || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  // Both bars share the same payload row, so we read everything off the first
  // entry rather than searching by dataKey.
  const first = payload[0];
  const rowPayload = first.payload ?? {};
  const currentEntry =
    payload.find((entry) => entry.dataKey === "turnover") ?? first;
  const previousEntry = payload.find(
    (entry) => entry.dataKey === "previousTurnover",
  );

  const turnover = Number(currentEntry.value ?? 0);
  const invoiceCount = Number(rowPayload.invoiceCount ?? 0);
  const hasPrevious = previousEntry !== undefined;
  const previousTurnover = Number(rowPayload.previousTurnover ?? 0);
  const previousInvoiceCount = Number(rowPayload.previousInvoiceCount ?? 0);
  const previousMonthLabel = rowPayload.previousMonthLabel ?? null;

  return (
    <div className="grid min-w-[12rem] gap-1.5 rounded-md border bg-background px-3 py-2 text-xs shadow-xl">
      {label != null ? (
        <div className="font-medium">{String(label)}</div>
      ) : null}
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{turnoverLabel}</span>
          <span className="font-medium tabular-nums">
            {turnover.toLocaleString("sv-SE", { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{invoicesLabel}</span>
          <span className="font-medium tabular-nums">
            {invoiceCount.toLocaleString("sv-SE")}
          </span>
        </div>
      </div>
      {hasPrevious ? (
        <>
          <div className="border-t pt-1.5 text-[11px] font-medium text-muted-foreground">
            {previousLabel}
            {previousMonthLabel ? ` · ${previousMonthLabel}` : ""}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{turnoverLabel}</span>
              <span className="font-medium tabular-nums">
                {previousTurnover.toLocaleString("sv-SE", { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{invoicesLabel}</span>
              <span className="font-medium tabular-nums">
                {previousInvoiceCount.toLocaleString("sv-SE")}
              </span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SearchSelect({
  placeholder,
  searchPlaceholder,
  options,
  value,
  onChange,
  disabled = false,
  allLabel = "All",
  allowClear = true,
  noOptionsLabel = "No options found.",
}: SearchSelectProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.id === value) ?? null;

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between"
            disabled={disabled}
          >
            <span className="truncate text-left">
              {selected?.label ?? placeholder}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          align="start"
        >
          <Command
            filter={(commandValue, search) =>
              prefixFilterScore(commandValue, search)
            }
          >
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              {allowClear ? (
                <CommandItem
                  key="all"
                  value={allLabel}
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      value === null ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span>{allLabel}</span>
                </CommandItem>
              ) : null}
              <CommandEmpty>{noOptionsLabel}</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                    value={option.label}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      value === option.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {option.showAvatar ? (
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                      {option.avatarFallback ?? "--"}
                    </span>
                  ) : null}
                  <div className="min-w-0">
                    <p className="truncate">{option.label}</p>
                    {option.subLabel ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {option.subLabel}
                      </p>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function ReportsPage() {
  const { user, isAdmin } = useUser();
  const { t } = useTranslation();
  const searchParams = useSearchParams();

  const [loading, setLoading] = React.useState(true);
  const [teams, setTeams] = React.useState<TeamOption[]>([]);
  const [managers, setManagers] = React.useState<ManagerOption[]>([]);
  // Lightweight name directory for ALL active profiles, regardless of role.
  // The filter dropdowns use `managers` (scoped — a team_lead only sees their
  // own team). But the "Help received / Help given" sections cross team
  // boundaries by design, so we need a separate directory to resolve names
  // for managers outside the current scope — otherwise those rows show as
  // "Unknown" for team_leads and regular users.
  const [managerDirectory, setManagerDirectory] = React.useState<
    Map<
      string,
      {
        full_name: string | null
        email: string
        fortnox_group_name: string | null
        team_id: string | null
      }
    >
  >(new Map());
  // Same idea as managerDirectory but for team names — needed because team_id
  // → group name resolution otherwise only knows teams in the user's scope.
  const [teamNameDirectory, setTeamNameDirectory] = React.useState<
    Map<string, string>
  >(new Map());
  const [customers, setCustomers] = React.useState<CustomerWithRelations[]>([]);

  const [selectedTeamId, setSelectedTeamId] = React.useState<string | null>(
    null,
  );
  const [selectedManagerId, setSelectedManagerId] = React.useState<
    string | null
  >(null);
  const [selectedCustomerId, setSelectedCustomerId] = React.useState<
    string | null
  >(null);
  const [selectedMonth, setSelectedMonth] = React.useState<string>(() =>
    getDefaultReportsMonthKey(),
  );
  const [selectedWindowMode, setSelectedWindowMode] =
    React.useState<ReportingWindowMode>("rolling-12-months");
  const [comparisonMode, setComparisonMode] =
    React.useState<ComparisonMode>("year-over-year");
  const [turnoverChartMode, setTurnoverChartMode] = React.useState<
    "bar" | "line"
  >("bar");
  const savedFiltersRef = React.useRef<SavedReportsFilters | null>(null);
  const hasAppliedSavedFiltersRef = React.useRef(false);
  const [kpiLoading, setKpiLoading] = React.useState(false);
  const [kpis, setKpis] = React.useState({
    turnover: 0,
    invoices: 0,
    hours: 0,
    contractValue: 0,
  });
  const [previousKpis, setPreviousKpis] = React.useState<{
    turnover: number;
    invoices: number;
    hours: number;
    contractValue: number;
  } | null>(null);
  // Contract value at the latest month of the *current* window, sourced from
  // customer_kpis so the comparison pill compares snapshot-to-snapshot. The
  // displayed contract value still comes from the live contract_accruals
  // sum, which is more accurate but not what historical snapshots contain.
  const [currentContractValueSnapshot, setCurrentContractValueSnapshot] =
    React.useState<number | null>(null);
  // Per-month turnover for the *previous* period, paired with the current
  // period at the same array index so the chart can render side-by-side bars.
  const [previousTurnoverByMonthRows, setPreviousTurnoverByMonthRows] =
    React.useState<TurnoverMonthRow[] | null>(null);
  const [accrualsLoading, setAccrualsLoading] = React.useState(false);
  const [customerAccruals, setCustomerAccruals] = React.useState<
    ContractAccrual[]
  >([]);
  const [customerMonthlyEconomicsLoading, setCustomerMonthlyEconomicsLoading] =
    React.useState(false);
  const [customerMonthlyEconomicsRows, setCustomerMonthlyEconomicsRows] =
    React.useState<CustomerMonthlyEconomicsRow[]>([]);
  const [monthlyTimeReportingLoading, setMonthlyTimeReportingLoading] =
    React.useState(false);
  const [monthlyTimeReportingRows, setMonthlyTimeReportingRows] =
    React.useState<MonthlyTimeReportingRow[]>([]);
  const [customerTimeReportingLoading, setCustomerTimeReportingLoading] =
    React.useState(false);
  const [customerTimeReportingRows, setCustomerTimeReportingRows] =
    React.useState<CustomerTimeReportingRow[]>([]);
  const [
    otherManagersTimeReportingLoading,
    setOtherManagersTimeReportingLoading,
  ] = React.useState(false);
  const [otherManagersTimeReportingRows, setOtherManagersTimeReportingRows] =
    React.useState<CustomerTimeReportingRow[]>([]);
  const [helpedCustomerManagersLoading, setHelpedCustomerManagersLoading] =
    React.useState(false);
  const [helpedCustomerManagersRows, setHelpedCustomerManagersRows] =
    React.useState<HelpedCustomerManagerRow[]>([]);
  const [managerCustomerSummaryLoading, setManagerCustomerSummaryLoading] =
    React.useState(false);
  const [managerCustomerSummaryRows, setManagerCustomerSummaryRows] =
    React.useState<ManagerCustomerSummaryRow[]>([]);
  const [articleGroupsLoading, setArticleGroupsLoading] = React.useState(false);
  const [articleGroupRows, setArticleGroupRows] = React.useState<
    ArticleGroupSummaryRow[]
  >([]);
  const [openArticleGroups, setOpenArticleGroups] = React.useState<
    Record<string, boolean>
  >({});
  const [monthlyArticleGroupFilterOpen, setMonthlyArticleGroupFilterOpen] =
    React.useState(false);
  const [monthlyArticleGroupValues, setMonthlyArticleGroupValues] =
    React.useState<string[]>([]);
  const [selectedMonthlyArticleGroups, setSelectedMonthlyArticleGroups] =
    React.useState<string[]>([]);
  const [monthlyInvoiceGroupRows, setMonthlyInvoiceGroupRows] = React.useState<
    MonthlyInvoiceGroupRow[]
  >([]);
  const [monthlyHourGroupRows, setMonthlyHourGroupRows] = React.useState<
    MonthlyHourGroupRow[]
  >([]);

  const scrollReportsViewportToTop = React.useCallback(() => {
    const viewport = document.querySelector("main.overflow-y-auto");
    if (viewport instanceof HTMLElement) {
      viewport.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const [timeDetailsOpen, setTimeDetailsOpen] = React.useState(false);
  const [timeDetailsLoading, setTimeDetailsLoading] = React.useState(false);
  const [timeDetailsTitle, setTimeDetailsTitle] = React.useState("");
  const [timeDetailsRows, setTimeDetailsRows] = React.useState<TimeDetailRow[]>(
    [],
  );
  const [invoiceDetailsOpen, setInvoiceDetailsOpen] = React.useState(false);
  const [invoiceDetailsLoading, setInvoiceDetailsLoading] =
    React.useState(false);
  const [invoiceDetailsTitle, setInvoiceDetailsTitle] = React.useState("");
  const [invoiceDetailsRows, setInvoiceDetailsRows] = React.useState<
    InvoiceDetailRow[]
  >([]);
  const [invoiceDetailsStatusFilter, setInvoiceDetailsStatusFilter] = React.useState<
    "all" | "paid" | "pending"
  >("all");
  const [invoiceDetailsMode, setInvoiceDetailsMode] = React.useState<
    "default" | "status-list"
  >("default");
  const [contractDetailsOpen, setContractDetailsOpen] = React.useState(false);
  const [contractDetailsLoading, setContractDetailsLoading] =
    React.useState(false);
  const [contractDetailsTitle, setContractDetailsTitle] = React.useState("");
  const [contractDetailsRows, setContractDetailsRows] = React.useState<
    ContractAccrual[]
  >([]);
  const [turnoverByMonthRows, setTurnoverByMonthRows] = React.useState<
    TurnoverMonthRow[]
  >([]);
  const turnoverGradientId = React.useId();
  const filteredInvoiceDetailsRows = React.useMemo(() => {
    if (invoiceDetailsMode !== "status-list") {
      return invoiceDetailsRows;
    }

    if (invoiceDetailsStatusFilter === "all") {
      return invoiceDetailsRows;
    }

    return invoiceDetailsRows.filter(
      (row) => row.status === invoiceDetailsStatusFilter,
    );
  }, [invoiceDetailsMode, invoiceDetailsRows, invoiceDetailsStatusFilter]);

  const customerIdFromQuery = searchParams.get("customerId");
  const turnoverChartData = React.useMemo(
    () =>
      turnoverByMonthRows
        .map((row, idx) => {
          const prev = previousTurnoverByMonthRows?.[idx] ?? null;
          return {
            month: row.monthLabel,
            turnover: row.turnover,
            invoiceCount: row.invoiceCount,
            previousTurnover: prev?.turnover ?? 0,
            previousInvoiceCount: prev?.invoiceCount ?? 0,
            previousMonthLabel: prev?.monthLabel ?? null,
          };
        })
        .reverse(),
    [previousTurnoverByMonthRows, turnoverByMonthRows],
  );

  React.useEffect(() => {
    const saved = parseSavedReportsFilters(
      localStorage.getItem(REPORTS_FILTERS_STORAGE_KEY),
    );

    if (!saved) return;

    savedFiltersRef.current = saved;

    if (saved.selectedMonth) {
      setSelectedMonth(saved.selectedMonth);
    }

    if (saved.selectedWindowMode) {
      setSelectedWindowMode(saved.selectedWindowMode);
    }

    if (saved.comparisonMode) {
      setComparisonMode(saved.comparisonMode);
    }
  }, []);

  const showTeamFilter = isAdmin || user.role === "team_lead";
  const teamFilterDisabled = user.role === "team_lead" && !isAdmin;
  // The month picker is only meaningful in `current-month` mode. Hiding it
  // for the rolling modes shrinks the filter row by one column.
  const showMonthPicker = selectedWindowMode === "current-month";
  const filterGridClass = (() => {
    if (showTeamFilter && showMonthPicker) {
      return "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)_minmax(0,2.5fr)_minmax(0,1fr)_minmax(0,1.25fr)]";
    }
    if (showTeamFilter) {
      return "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)_minmax(0,2.5fr)_minmax(0,1.25fr)]";
    }
    if (showMonthPicker) {
      return "lg:grid-cols-[minmax(0,1.9fr)_minmax(0,2.5fr)_minmax(0,1fr)_minmax(0,1.25fr)]";
    }
    return "lg:grid-cols-[minmax(0,1.9fr)_minmax(0,2.5fr)_minmax(0,1.25fr)]";
  })();
  const monthOptions = React.useMemo<SelectOption[]>(
    () => createMonthOptions(REPORT_MONTH_OPTIONS_COUNT),
    [],
  );
  const rollingWindow = React.useMemo(
    () => getReportingWindowRange(selectedMonth, selectedWindowMode),
    [selectedMonth, selectedWindowMode],
  );
  const monthlyArticleGroupLabel = React.useCallback(
    (value: string) =>
      value === MONTHLY_UNMAPPED_ARTICLE_GROUP
        ? t("reports.articleGroups.unmapped", "Unmapped")
        : value,
    [t],
  );
  const selectedMonthlyArticleGroupSet = React.useMemo(
    () => new Set(selectedMonthlyArticleGroups),
    [selectedMonthlyArticleGroups],
  );
  const monthlyArticleGroupSummaryLabel = React.useMemo(() => {
    if (monthlyArticleGroupValues.length === 0) {
      return t("reports.filters.articleGroups.none", "No article groups found");
    }

    const selectedCount = selectedMonthlyArticleGroups.length;
    const totalCount = monthlyArticleGroupValues.length;
    if (selectedCount === totalCount) {
      return t("reports.filters.articleGroups.allSelected", "All article groups");
    }

    return `${selectedCount}/${totalCount} ${t("reports.filters.articleGroups.selected", "selected")}`;
  }, [monthlyArticleGroupValues.length, selectedMonthlyArticleGroups.length, t]);
  const reportingWindowOptions = React.useMemo<SelectOption[]>(
    () => [
      {
        id: "current-month",
        label: t("reports.filters.window.currentMonth", "Current month"),
      },
      {
        id: "rolling-12-months",
        label: t("reports.filters.window.rolling12Months", "Rollback 12 months"),
      },
      {
        id: "rolling-year",
        label: t("reports.filters.window.rollingYear", "Rollback year"),
      },
    ],
    [t],
  );

  const teamOptions = React.useMemo<SelectOption[]>(
    () => teams.map((team) => ({ id: team.id, label: team.name })),
    [teams],
  );

  const availableManagers = React.useMemo(() => {
    if (!selectedTeamId) return managers;
    return managers.filter((manager) => manager.team_id === selectedTeamId);
  }, [managers, selectedTeamId]);

  const managerOptions = React.useMemo<SelectOption[]>(
    () =>
      availableManagers.map((manager) => ({
        id: manager.id,
        label: manager.full_name ?? t("reports.unknownManager", "Unknown manager"),
      })),
    [availableManagers, t],
  );

  const teamScopedCustomers = React.useMemo(() => {
    if (!selectedTeamId) return customers;
    const allowedManagerIds = new Set(
      availableManagers.map((manager) => manager.id),
    );
    return customers.filter(
      (customer) =>
        customer.account_manager &&
        allowedManagerIds.has(customer.account_manager.id),
    );
  }, [customers, selectedTeamId, availableManagers]);

  const managerScopedCustomers = React.useMemo(() => {
    if (!selectedManagerId) return teamScopedCustomers;
    return teamScopedCustomers.filter(
      (customer) => customer.account_manager?.id === selectedManagerId,
    );
  }, [teamScopedCustomers, selectedManagerId]);

  const customerOptions = React.useMemo<SelectOption[]>(() => {
    const selectedManagerProfile =
      managers.find((manager) => manager.id === selectedManagerId) ?? null;
    const teamManagerIds = new Set(availableManagers.map((manager) => manager.id));
    const selectedManagerInitials = getInitials(
      selectedManagerProfile?.full_name ?? selectedManagerProfile?.email,
    );

    const rows = customers.map((customer) => {
      const belongsToSelectedManager =
        Boolean(selectedManagerId) &&
        customer.account_manager?.id === selectedManagerId;
      const belongsToSelectedTeam = Boolean(
        selectedTeamId &&
          customer.account_manager?.id &&
          teamManagerIds.has(customer.account_manager.id),
      );
      const showOwnerAvatarInTeamScope =
        Boolean(selectedTeamId) &&
        !selectedManagerId &&
        belongsToSelectedTeam;
      const ownerAvatarFallback = getInitials(
        customer.account_manager?.full_name ?? customer.account_manager?.email,
      );

      return {
        id: customer.id,
        label: customer.name,
        showAvatar: belongsToSelectedManager || showOwnerAvatarInTeamScope,
        avatarFallback: belongsToSelectedManager
          ? selectedManagerInitials
          : showOwnerAvatarInTeamScope
            ? ownerAvatarFallback
            : undefined,
        priority: belongsToSelectedManager ? 0 : 1,
      };
    });

    rows.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.label.localeCompare(b.label);
    });

    return rows.map(({ priority: _priority, ...option }) => option);
  }, [availableManagers, customers, managers, selectedManagerId, selectedTeamId]);

  const filteredCustomers = React.useMemo(() => {
    if (!selectedCustomerId) return managerScopedCustomers;
    return customers.filter(
      (customer) => customer.id === selectedCustomerId,
    );
  }, [customers, managerScopedCustomers, selectedCustomerId]);

  const selectedCustomer = React.useMemo(
    () => filteredCustomers[0] ?? null,
    [filteredCustomers],
  );

  const selectedManager = React.useMemo(
    () => managers.find((manager) => manager.id === selectedManagerId) ?? null,
    [managers, selectedManagerId],
  );

  const selectedTeam = React.useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  const customerAllLabel = React.useMemo(() => {
    if (selectedManagerId === user.id) {
      return t("reports.filters.myCustomers", "My customers");
    }

    if (selectedManager) {
      const possessive = toPossessive(
        selectedManager.full_name?.trim() || selectedManager.email,
      );
      if (!possessive) {
        return t("reports.filters.allCustomers", "All customers");
      }
      return `${possessive} ${t("reports.filters.customers", "customers")}`;
    }

    if (selectedTeam) {
      const possessive = toPossessive(selectedTeam.name);
      if (!possessive) {
        return t("reports.filters.allCustomers", "All customers");
      }
      return `${possessive} ${t("reports.filters.customers", "customers")}`;
    }

    return t("reports.filters.allCustomers", "All customers");
  }, [selectedManager, selectedManagerId, selectedTeam, t, user.id]);

  const managerAllLabel = React.useMemo(() => {
    if (!selectedTeam) {
      return t("reports.filters.allCustomerManagers", "All customer managers");
    }

    const possessiveTeam = toPossessive(selectedTeam.name);
    if (!possessiveTeam) {
      return t("reports.filters.allCustomerManagers", "All customer managers");
    }

    return `${t("reports.filters.all", "All")} ${possessiveTeam} ${t("reports.filters.customerManagers", "customer managers")}`;
  }, [selectedTeam, t]);

  const handleResetFilters = React.useCallback(() => {
    localStorage.removeItem(REPORTS_FILTERS_STORAGE_KEY);
    savedFiltersRef.current = null;
    hasAppliedSavedFiltersRef.current = true;

    setSelectedMonth(getDefaultReportsMonthKey());
    setSelectedWindowMode("rolling-12-months");

    if (user.role === "user") {
      setSelectedTeamId(null);
      setSelectedManagerId(user.id);
    } else if (user.role === "team_lead" && teams.length === 1 && !isAdmin) {
      setSelectedTeamId(teams[0].id);
      setSelectedManagerId(null);
    } else {
      setSelectedTeamId(null);
      setSelectedManagerId(null);
    }

    setSelectedCustomerId(null);
    setSelectedMonthlyArticleGroups([]);
  }, [isAdmin, teams, user.id, user.role]);

  const teamNameById = React.useMemo(() => {
    return new Map(teams.map((team) => [team.id, team.name]));
  }, [teams]);

  const managerById = React.useMemo(() => {
    return new Map(managers.map((manager) => [manager.id, manager]));
  }, [managers]);

  const managerByFortnoxUserId = React.useMemo(() => {
    const map = new Map<string, ManagerOption>();
    for (const manager of managers) {
      const normalized = normalizeIdentifier(manager.fortnox_user_id);
      if (normalized) {
        map.set(normalized, manager);
      }
    }
    return map;
  }, [managers]);

  const managerByFortnoxEmployeeId = React.useMemo(() => {
    const map = new Map<string, ManagerOption>();
    for (const manager of managers) {
      const normalized = normalizeIdentifier(manager.fortnox_employee_id);
      if (normalized) {
        map.set(normalized, manager);
      }
    }
    return map;
  }, [managers]);

  const managerByName = React.useMemo(() => {
    const map = new Map<string, ManagerOption>();
    for (const manager of managers) {
      const keys = [manager.full_name, manager.email];
      for (const key of keys) {
        const normalized = normalizeText(key);
        if (normalized && !map.has(normalized)) {
          map.set(normalized, manager);
        }
      }
    }
    return map;
  }, [managers]);

  const resolveReporterManagerId = React.useCallback(
    (row: { employee_id: string | null; employee_name: string | null }) => {
      const normalizedEmployeeId = normalizeIdentifier(row.employee_id);
      const byUserId = normalizedEmployeeId
        ? managerByFortnoxUserId.get(normalizedEmployeeId)
        : undefined;
      const byEmployeeId = normalizedEmployeeId
        ? managerByFortnoxEmployeeId.get(normalizedEmployeeId)
        : undefined;
      const contributorName = row.employee_name?.trim() ?? "";
      const byName = managerByName.get(normalizeText(contributorName));
      const managerMatch = byUserId ?? byEmployeeId ?? byName;

      return managerMatch?.id ?? null;
    },
    [managerByFortnoxEmployeeId, managerByFortnoxUserId, managerByName],
  );

  const isSelectedManagerReporter = React.useCallback(
    (row: { employee_id: string | null; employee_name: string | null }) => {
      if (!selectedManager) return false;

      const resolvedManagerId = resolveReporterManagerId(row);
      if (resolvedManagerId === selectedManager.id) {
        return true;
      }

      const normalizedEmployeeId = normalizeIdentifier(row.employee_id);

      const selectedUserId = normalizeIdentifier(
        selectedManager.fortnox_user_id,
      );
      const selectedEmployeeId = normalizeIdentifier(
        selectedManager.fortnox_employee_id,
      );
      if (
        normalizedEmployeeId &&
        (normalizedEmployeeId === selectedUserId ||
          normalizedEmployeeId === selectedEmployeeId)
      ) {
        return true;
      }

      const normalizedEmployeeName = normalizeText(row.employee_name);
      return (
        normalizedEmployeeName.length > 0 &&
        (normalizedEmployeeName === normalizeText(selectedManager.full_name) ||
          normalizedEmployeeName === normalizeText(selectedManager.email))
      );
    },
    [resolveReporterManagerId, selectedManager],
  );

  function formatTimeDetailRows(
    rows: Array<{
      id: string;
      report_date: string | null;
      customer_name: string | null;
      employee_id: string | null;
      employee_name: string | null;
      entry_type: string | null;
      project_name: string | null;
      activity: string | null;
      description: string | null;
      hours: number | null;
    }>,
    metric: TimeDetailMetric,
  ): TimeDetailRow[] {
    return rows
      .filter((row) => matchesMetric(row.entry_type, metric))
      .map((row) => {
        const normalizedEmployeeId = normalizeIdentifier(row.employee_id);
        const mappedContributorName = row.employee_id
          ? ((
              managerByFortnoxUserId.get(
                normalizeIdentifier(row.employee_id),
              ) ??
              managerByFortnoxEmployeeId.get(
                normalizeIdentifier(row.employee_id),
              )
            )?.full_name ?? null)
          : null;
        const baseContributorName = row.employee_name ?? t("reports.unknown", "Unknown");
        const displayContributorName = mappedContributorName
          ? mappedContributorName
          : normalizedEmployeeId
            ? `${baseContributorName} (ID: ${normalizedEmployeeId})`
            : baseContributorName;

        return {
          id: row.id,
          reportDate: row.report_date,
          customerName: row.customer_name,
          employeeName: displayContributorName,
          entryType: row.entry_type,
          projectName: row.project_name,
          activity: row.activity,
          description: row.description,
          hours: Number(row.hours ?? 0),
        };
      })
      .sort((a, b) => (b.reportDate ?? "").localeCompare(a.reportDate ?? ""));
  }

  function renderHourCell(value: number, onClick?: () => void) {
    if (value === 0 || !onClick) {
      return <span>{hoursFormatter.format(value)}</span>;
    }

    return (
      <button
        type="button"
        onClick={onClick}
        className="font-medium underline underline-offset-2 hover:text-foreground"
      >
        {hoursFormatter.format(value)}
      </button>
    );
  }

function renderTurnoverCell(
  value: number | null,
  onClick?: () => void,
  showNotExVatLabel = false,
) {
  if (value == null) {
    return <span className="text-muted-foreground">{t("reports.missing", "missing")}</span>;
  }

  const valueText = `${sekFormatter.format(value)}${showNotExVatLabel ? ` ${t("reports.notExVat", "(NOT ex VAT)")}` : ""}`;

  if (value === 0 || !onClick) {
    return <span>{valueText}</span>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="font-medium underline underline-offset-2 hover:text-foreground"
    >
      {valueText}
    </button>
  );
}

function renderWorkloadShareCell(percentage: number) {
  const clamped = Math.min(Math.max(percentage, 0), 100);
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-[oklch(0.62_0.15_252)]"
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="w-10 text-right text-muted-foreground">
        {Math.round(clamped)}%
      </span>
    </div>
  );
}

  async function openCustomerTimeDetails(
    row: CustomerTimeReportingRow,
    metric: TimeDetailMetric,
  ) {
    if (!selectedCustomerId) return;

    setTimeDetailsOpen(true);
    setTimeDetailsLoading(true);
    setTimeDetailsRows([]);
    setTimeDetailsTitle(
      `${selectedCustomer?.name ?? "Selected customer"} · ${row.contributorName} · ${metricLabel(metric)} · ${rollingWindow.title}`,
    );

    let query = createClient()
      .from("time_reports")
      .select(
        "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
      )
      .gte("report_date", rollingWindow.from)
      .lte("report_date", rollingWindow.to);

    if (selectedCustomer?.fortnox_customer_number) {
      query = query.or(
        `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
      );
    } else {
      query = query.eq("customer_id", selectedCustomerId);
    }

    if (row.contributorId) {
      query = query.eq("employee_id", row.contributorId);
    } else {
      query = query
        .is("employee_id", null)
        .eq("employee_name", row.contributorName);
    }

    const { data, error } = await query;

    if (error) {
      setTimeDetailsRows([]);
      setTimeDetailsLoading(false);
      return;
    }

    const detailRows = formatTimeDetailRows(
      (data ?? []) as Array<{
        id: string;
        report_date: string | null;
        customer_name: string | null;
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        project_name: string | null;
        activity: string | null;
        description: string | null;
        hours: number | null;
      }>,
      metric,
    );

    setTimeDetailsRows(detailRows);
    setTimeDetailsLoading(false);
  }

  async function openMonthlyTimeDetails(
    row: MonthlyTimeReportingRow,
    metric: TimeDetailMetric,
  ) {
    const { from, to } = getMonthDateRange(row.monthKey);

    if (selectedManagerId && !selectedCustomerId) {
      setTimeDetailsOpen(true);
      setTimeDetailsLoading(true);
      setTimeDetailsRows([]);
      setTimeDetailsTitle(`${row.monthLabel} · ${metricLabel(metric)}`);

      const supabase = createClient();
      const allRows: Array<{
        id: string;
        report_date: string | null;
        customer_name: string | null;
        fortnox_customer_number: string | null;
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        project_name: string | null;
        activity: string | null;
        description: string | null;
        hours: number | null;
      }> = [];
      let pageFrom = 0;

      while (true) {
        const { data, error } = await supabase
          .from("time_reports")
          .select(
            "id, report_date, customer_name, fortnox_customer_number, employee_id, employee_name, entry_type, project_name, activity, description, hours",
          )
          .gte("report_date", from)
          .lte("report_date", to)
          .range(pageFrom, pageFrom + TIME_REPORTS_PAGE_SIZE - 1);

        if (error) {
          setTimeDetailsRows([]);
          setTimeDetailsLoading(false);
          return;
        }

        const pageRows = (data ?? []) as Array<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          fortnox_customer_number: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>;

        allRows.push(...pageRows);

        if (pageRows.length < TIME_REPORTS_PAGE_SIZE) {
          break;
        }

        pageFrom += TIME_REPORTS_PAGE_SIZE;
      }

      const scopedRows = allRows.filter((timeRow) =>
        isSelectedManagerReporter(timeRow),
      );

      if (metric === "internalHours") {
        const internalScopeRows = scopedRows.filter((timeRow) =>
          isInternalFortnoxCustomer(timeRow.fortnox_customer_number),
        );
        setTimeDetailsRows(
          formatTimeDetailRows(internalScopeRows, "totalHours"),
        );
      } else if (metric === "customerHours") {
        // Mirror the aggregate logic in sync-generate-kpis: internal customers
        // (Saldo Redo's own books) are bucketed as internal_hours, not
        // customer_hours. Without this filter the drill-down list would leak
        // those entries even though they don't contribute to the column total.
        const externalScopeRows = scopedRows.filter(
          (timeRow) =>
            !isInternalFortnoxCustomer(timeRow.fortnox_customer_number),
        );
        setTimeDetailsRows(formatTimeDetailRows(externalScopeRows, metric));
      } else {
        setTimeDetailsRows(formatTimeDetailRows(scopedRows, metric));
      }
      setTimeDetailsLoading(false);
      return;
    }

    if (filteredCustomers.length === 0) return;

    // When the metric is customer_hours, drop internal customers (Saldo Redo's
    // own books) from the scope so their entries never reach the drill-down.
    // The aggregate already excludes them; mirroring it here keeps the detail
    // list consistent with the column total.
    const customerScope = filteredCustomers
      .map((customer) => ({
        id: customer.id,
        fortnoxCustomerNumber: customer.fortnox_customer_number,
      }))
      .filter((customer) =>
        metric === "customerHours"
          ? !isInternalFortnoxCustomer(customer.fortnoxCustomerNumber)
          : true,
      );
    const customerScopeChunks = chunkArray(customerScope, 200);

    setTimeDetailsOpen(true);
    setTimeDetailsLoading(true);
    setTimeDetailsRows([]);
    setTimeDetailsTitle(`${row.monthLabel} · ${metricLabel(metric)}`);

    const supabase = createClient();
    const allRows: Array<{
      id: string;
      report_date: string | null;
      customer_name: string | null;
      employee_id: string | null;
      employee_name: string | null;
      entry_type: string | null;
      project_name: string | null;
      activity: string | null;
      description: string | null;
      hours: number | null;
    }> = [];
    const seenRowIds = new Set<string>();

    function addRows(
      rows: Array<{
        id: string;
        report_date: string | null;
        customer_name: string | null;
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        project_name: string | null;
        activity: string | null;
        description: string | null;
        hours: number | null;
      }>,
    ) {
      for (const reportRow of rows) {
        if (seenRowIds.has(reportRow.id)) continue;
        seenRowIds.add(reportRow.id);
        allRows.push(reportRow);
      }
    }

    for (const scopeChunk of customerScopeChunks) {
      const customerIds = scopeChunk.map((customer) => customer.id);
      const customerNumbers = scopeChunk
        .map((customer) => customer.fortnoxCustomerNumber)
        .filter((value): value is string => Boolean(value));

      if (customerIds.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("customer_id", customerIds)
            .gte("report_date", from)
            .lte("report_date", to),
        );

        addRows(rows);
      }

      if (customerNumbers.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("fortnox_customer_number", customerNumbers)
            .gte("report_date", from)
            .lte("report_date", to),
        );

        addRows(rows);
      }
    }

    const detailRows = formatTimeDetailRows(allRows, metric);
    setTimeDetailsRows(detailRows);
    setTimeDetailsLoading(false);
  }

  async function openOtherManagersTimeDetails(
    row: CustomerTimeReportingRow,
    metric: TimeDetailMetric,
  ) {
    if (
      !selectedManagerId ||
      selectedCustomerId ||
      filteredCustomers.length === 0
    ) {
      return;
    }

    setTimeDetailsOpen(true);
    setTimeDetailsLoading(true);
    setTimeDetailsRows([]);
    setTimeDetailsTitle(
      `${row.contributorName} · ${metricLabel(metric)} · ${rollingWindow.title}`,
    );

    // See the openMonthlyTimeDetails customer_hours comment — same rule
    // applies here for the "other managers / contributors" drill-down.
    const customerScope = filteredCustomers
      .map((customer) => ({
        id: customer.id,
        fortnoxCustomerNumber: customer.fortnox_customer_number,
      }))
      .filter((customer) =>
        metric === "customerHours"
          ? !isInternalFortnoxCustomer(customer.fortnoxCustomerNumber)
          : true,
      );
    const customerScopeChunks = chunkArray(customerScope, 200);

    const supabase = createClient();
    const allRows: Array<{
      id: string;
      report_date: string | null;
      customer_name: string | null;
      employee_id: string | null;
      employee_name: string | null;
      entry_type: string | null;
      project_name: string | null;
      activity: string | null;
      description: string | null;
      hours: number | null;
    }> = [];
    const seenRowIds = new Set<string>();

    function addRows(
      rows: Array<{
        id: string;
        report_date: string | null;
        customer_name: string | null;
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        project_name: string | null;
        activity: string | null;
        description: string | null;
        hours: number | null;
      }>,
    ) {
      for (const reportRow of rows) {
        if (seenRowIds.has(reportRow.id)) continue;
        seenRowIds.add(reportRow.id);
        allRows.push(reportRow);
      }
    }

    for (const scopeChunk of customerScopeChunks) {
      const customerIds = scopeChunk.map((customer) => customer.id);
      const customerNumbers = scopeChunk
        .map((customer) => customer.fortnoxCustomerNumber)
        .filter((value): value is string => Boolean(value));

      if (customerIds.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("customer_id", customerIds)
            .gte("report_date", rollingWindow.from)
            .lte("report_date", rollingWindow.to),
        );

        addRows(rows);
      }

      if (customerNumbers.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("fortnox_customer_number", customerNumbers)
            .gte("report_date", rollingWindow.from)
            .lte("report_date", rollingWindow.to),
        );

        addRows(rows);
      }
    }

    const matchingRows = allRows.filter((reportRow) => {
      if (row.managerProfileId) {
        return resolveReporterManagerId(reportRow) === row.managerProfileId;
      }

      return isSelectedManagerReporter(reportRow);
    });

    setTimeDetailsRows(formatTimeDetailRows(matchingRows, metric));
    setTimeDetailsLoading(false);
  }

  async function openHelpedCustomerManagersDetails(
    row: HelpedCustomerManagerRow,
    metric: TimeDetailMetric,
  ) {
    if (!selectedManagerId || selectedCustomerId || !row.managerProfileId) {
      return;
    }

    const managerCustomers = customers.filter(
      (customer) => customer.account_manager?.id === row.managerProfileId,
    );

    if (managerCustomers.length === 0) {
      setTimeDetailsOpen(true);
      setTimeDetailsLoading(false);
      setTimeDetailsRows([]);
      setTimeDetailsTitle(
        `${row.managerName} · ${metricLabel(metric)} · ${rollingWindow.title}`,
      );
      return;
    }

    setTimeDetailsOpen(true);
    setTimeDetailsLoading(true);
    setTimeDetailsRows([]);
    setTimeDetailsTitle(
      `${row.managerName} · ${metricLabel(metric)} · ${rollingWindow.title}`,
    );

    // Same internal-customer exclusion as the other two drill-down paths.
    const customerScope = managerCustomers
      .map((customer) => ({
        id: customer.id,
        fortnoxCustomerNumber: customer.fortnox_customer_number,
      }))
      .filter((customer) =>
        metric === "customerHours"
          ? !isInternalFortnoxCustomer(customer.fortnoxCustomerNumber)
          : true,
      );
    const customerScopeChunks = chunkArray(customerScope, 200);

    const supabase = createClient();
    const allRows: Array<{
      id: string;
      report_date: string | null;
      customer_name: string | null;
      employee_id: string | null;
      employee_name: string | null;
      entry_type: string | null;
      project_name: string | null;
      activity: string | null;
      description: string | null;
      hours: number | null;
    }> = [];
    const seenRowIds = new Set<string>();

    function addRows(
      rows: Array<{
        id: string;
        report_date: string | null;
        customer_name: string | null;
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        project_name: string | null;
        activity: string | null;
        description: string | null;
        hours: number | null;
      }>,
    ) {
      for (const reportRow of rows) {
        if (seenRowIds.has(reportRow.id)) continue;
        seenRowIds.add(reportRow.id);
        allRows.push(reportRow);
      }
    }

    for (const scopeChunk of customerScopeChunks) {
      const customerIds = scopeChunk.map((customer) => customer.id);
      const customerNumbers = scopeChunk
        .map((customer) => customer.fortnoxCustomerNumber)
        .filter((value): value is string => Boolean(value));

      if (customerIds.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("customer_id", customerIds)
            .gte("report_date", rollingWindow.from)
            .lte("report_date", rollingWindow.to),
        );

        addRows(rows);
      }

      if (customerNumbers.length > 0) {
        const rows = await fetchAllPages<{
          id: string;
          report_date: string | null;
          customer_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          entry_type: string | null;
          project_name: string | null;
          activity: string | null;
          description: string | null;
          hours: number | null;
        }>(() =>
          supabase
            .from("time_reports")
            .select(
              "id, report_date, customer_name, employee_id, employee_name, entry_type, project_name, activity, description, hours",
            )
            .in("fortnox_customer_number", customerNumbers)
            .gte("report_date", rollingWindow.from)
            .lte("report_date", rollingWindow.to),
        );

        addRows(rows);
      }
    }

    const matchingRows = allRows.filter((reportRow) =>
      isSelectedManagerReporter(reportRow),
    );

    setTimeDetailsRows(formatTimeDetailRows(matchingRows, metric));
    setTimeDetailsLoading(false);
  }

  async function openMonthlyInvoiceDetails(row: CustomerMonthlyEconomicsRow) {
    setInvoiceDetailsMode("default");
    if (!selectedCustomerId) return;

    const { from, to } = getMonthDateRange(row.monthKey);

    setInvoiceDetailsOpen(true);
    setInvoiceDetailsLoading(true);
    setInvoiceDetailsRows([]);
    setInvoiceDetailsTitle(
      `${selectedCustomer?.name ?? t("reports.selectedCustomer", "Selected customer")} · ${row.monthLabel} · ${t("reports.columns.turnover", "Turnover")}`,
    );

    const supabase = createClient();
    const withCustomerScope = (query: ReturnType<typeof supabase.from>) => {
      let scoped = query.gte("invoice_date", from).lte("invoice_date", to);
      if (selectedCustomer?.fortnox_customer_number) {
        scoped = scoped.or(
          `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
        );
      } else {
        scoped = scoped.eq("customer_id", selectedCustomerId);
      }
      return scoped.order("invoice_date", { ascending: false });
    };

    let dueDateAvailable = true;
    let dueDateRows: Array<{
      id: string;
      document_number: string;
      invoice_date: string | null;
      due_date: string | null;
      total_ex_vat: number | null;
      total: number | null;
      currency_code: string | null;
    }> = [];

    const withDueDate = await withCustomerScope(
      supabase
        .from("invoices")
        .select(
          "id, document_number, customer_name, invoice_date, due_date, total_ex_vat, total, currency_code, balance",
        ),
    );

    if (withDueDate.error && withDueDate.error.message.includes("due_date")) {
      dueDateAvailable = false;
    } else if (withDueDate.error) {
      setInvoiceDetailsRows([]);
      setInvoiceDetailsLoading(false);
      return;
    } else {
      dueDateRows = (withDueDate.data ?? []) as Array<{
        id: string;
        document_number: string;
        invoice_date: string | null;
        due_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>;
    }

    if (!dueDateAvailable) {
      const withoutDueDate = await withCustomerScope(
        supabase
          .from("invoices")
          .select(
            "id, document_number, customer_name, invoice_date, total_ex_vat, total, currency_code, balance",
          ),
      );

      if (withoutDueDate.error) {
        setInvoiceDetailsRows([]);
        setInvoiceDetailsLoading(false);
        return;
      }

      const rows = (withoutDueDate.data ?? []) as Array<{
        id: string;
        document_number: string;
        invoice_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>;

      setInvoiceDetailsRows(
        mapInvoicesToDetailRows(rows, {
          fallbackDocumentNumber: "-",
          includeDueDate: false,
        }),
      );
      setInvoiceDetailsLoading(false);
      return;
    }

    setInvoiceDetailsRows(
      mapInvoicesToDetailRows(dueDateRows, {
        fallbackDocumentNumber: "-",
        includeDueDate: true,
      }),
    );
    setInvoiceDetailsLoading(false);
  }

  async function openManagerCustomerContractDetails(
    row: ManagerCustomerSummaryRow,
  ) {
    setContractDetailsOpen(true);
    setContractDetailsLoading(true);
    setContractDetailsRows([]);
    setContractDetailsTitle(`${row.customerName} · Contract Accruals`);

    const customer = customers.find((item) => item.id === row.customerId) ?? null;
    if (!customer?.fortnox_customer_number) {
      setContractDetailsRows([]);
      setContractDetailsLoading(false);
      return;
    }

    const { data, error } = await createClient()
      .from("contract_accruals")
      .select(
        "id, contract_number, description, period, start_date, end_date, total_ex_vat, total, is_active",
      )
      .eq("fortnox_customer_number", customer.fortnox_customer_number)
      .order("start_date", { ascending: false });

    if (error) {
      setContractDetailsRows([]);
      setContractDetailsLoading(false);
      return;
    }

    setContractDetailsRows((data ?? []) as ContractAccrual[]);
    setContractDetailsLoading(false);
  }

  async function openManagerCustomerInvoiceDetails(
    row: ManagerCustomerSummaryRow,
  ) {
    setInvoiceDetailsMode("default");
    setInvoiceDetailsOpen(true);
    setInvoiceDetailsLoading(true);
    setInvoiceDetailsRows([]);
    setInvoiceDetailsTitle(
      `${row.customerName} · ${rollingWindow.title} · ${t("reports.columns.turnover", "Turnover")}`,
    );

    const customer = customers.find((item) => item.id === row.customerId) ?? null;
    const supabase = createClient();

    const withCustomerScope = (query: ReturnType<typeof supabase.from>) => {
      let scoped = query
        .gte("invoice_date", rollingWindow.from)
        .lte("invoice_date", rollingWindow.to);
      if (customer?.fortnox_customer_number) {
        scoped = scoped.or(
          `customer_id.eq.${row.customerId},fortnox_customer_number.eq.${customer.fortnox_customer_number}`,
        );
      } else {
        scoped = scoped.eq("customer_id", row.customerId);
      }
      return scoped.order("invoice_date", { ascending: false });
    };

    let dueDateAvailable = true;
    let dueDateRows: Array<{
      id: string;
      document_number: string;
      invoice_date: string | null;
      due_date: string | null;
      total_ex_vat: number | null;
      total: number | null;
      currency_code: string | null;
    }> = [];

    const withDueDate = await withCustomerScope(
      supabase
        .from("invoices")
        .select(
          "id, document_number, customer_name, invoice_date, due_date, total_ex_vat, total, currency_code, balance",
        ),
    );

    if (withDueDate.error && withDueDate.error.message.includes("due_date")) {
      dueDateAvailable = false;
    } else if (withDueDate.error) {
      setInvoiceDetailsRows([]);
      setInvoiceDetailsLoading(false);
      return;
    } else {
      dueDateRows = (withDueDate.data ?? []) as Array<{
        id: string;
        document_number: string;
        invoice_date: string | null;
        due_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>;
    }

    if (!dueDateAvailable) {
      const withoutDueDate = await withCustomerScope(
        supabase
          .from("invoices")
          .select(
            "id, document_number, customer_name, invoice_date, total_ex_vat, total, currency_code, balance",
          ),
      );

      if (withoutDueDate.error) {
        setInvoiceDetailsRows([]);
        setInvoiceDetailsLoading(false);
        return;
      }

      const rows = (withoutDueDate.data ?? []) as Array<{
        id: string;
        document_number: string;
        invoice_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>;

      setInvoiceDetailsRows(
        mapInvoicesToDetailRows(rows, {
          fallbackDocumentNumber: "-",
          includeDueDate: false,
        }),
      );
      setInvoiceDetailsLoading(false);
      return;
    }

    setInvoiceDetailsRows(
      mapInvoicesToDetailRows(dueDateRows, {
        fallbackDocumentNumber: "-",
        includeDueDate: true,
      }),
    );
    setInvoiceDetailsLoading(false);
  }

  async function openArticleItemInvoiceDetails(
    groupName: string,
    article: ArticleGroupItemRow,
  ) {
    setInvoiceDetailsMode("default");
    if (!selectedCustomerId) return;

    setInvoiceDetailsOpen(true);
    setInvoiceDetailsLoading(true);
    setInvoiceDetailsRows([]);
    setInvoiceDetailsTitle(
      `${selectedCustomer?.name ?? t("reports.selectedCustomer", "Selected customer")} · ${groupName} · ${article.articleName} · ${t("reports.columns.turnover", "Turnover")}`,
    );

    const supabase = createClient();
    const withCustomerScope = (query: ReturnType<typeof supabase.from>) => {
      let scoped = query
        .gte("invoice_date", rollingWindow.from)
        .lte("invoice_date", rollingWindow.to);
      if (selectedCustomer?.fortnox_customer_number) {
        scoped = scoped.or(
          `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
        );
      } else {
        scoped = scoped.eq("customer_id", selectedCustomerId);
      }
      return scoped.order("invoice_date", { ascending: false });
    };

    let dueDateAvailable = true;
    let scopedInvoices: Array<{
      id: string;
      document_number: string | null;
      invoice_date: string | null;
      due_date: string | null;
      total_ex_vat: number | null;
      total: number | null;
      currency_code: string | null;
    }> = [];

    const withDueDate = await withCustomerScope(
      supabase
        .from("invoices")
        .select(
          "id, document_number, customer_name, invoice_date, due_date, total_ex_vat, total, currency_code, balance",
        ),
    );

    if (withDueDate.error && withDueDate.error.message.includes("due_date")) {
      dueDateAvailable = false;
    } else if (withDueDate.error) {
      setInvoiceDetailsRows([]);
      setInvoiceDetailsLoading(false);
      return;
    } else {
      scopedInvoices = (withDueDate.data ?? []) as Array<{
        id: string;
        document_number: string | null;
        invoice_date: string | null;
        due_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>;
    }

    if (!dueDateAvailable) {
      const withoutDueDate = await withCustomerScope(
        supabase
          .from("invoices")
          .select(
            "id, document_number, customer_name, invoice_date, total_ex_vat, total, currency_code, balance",
          ),
      );

      if (withoutDueDate.error) {
        setInvoiceDetailsRows([]);
        setInvoiceDetailsLoading(false);
        return;
      }

      scopedInvoices = ((withoutDueDate.data ?? []) as Array<{
        id: string;
        document_number: string | null;
        invoice_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
      }>).map((invoice) => ({
        ...invoice,
        due_date: null,
      }));
    }

    const invoiceNumbers = scopedInvoices
      .map((invoice) => invoice.document_number?.trim() ?? "")
      .filter((value) => value.length > 0);

    if (invoiceNumbers.length === 0) {
      setInvoiceDetailsRows([]);
      setInvoiceDetailsLoading(false);
      return;
    }

    const targetArticleNumber = article.articleNumber?.trim() ?? null;
    const targetArticleName = article.articleName.trim().toLowerCase();
    const matchedInvoiceNumbers = new Set<string>();

    for (const chunk of chunkArray(invoiceNumbers, 200)) {
      const invoiceRowsData = await fetchAllPages<{
        invoice_number: string | null;
        article_number: string | null;
        article_name: string | null;
      }>(() =>
        supabase
          .from("invoice_rows")
          .select("invoice_number, article_number, article_name")
          .in("invoice_number", chunk),
      );

      for (const row of invoiceRowsData) {
        const invoiceNumber = row.invoice_number?.trim();
        if (!invoiceNumber) continue;

        if (targetArticleNumber) {
          if (row.article_number?.trim() === targetArticleNumber) {
            matchedInvoiceNumbers.add(invoiceNumber);
          }
          continue;
        }

        const rowArticleName = row.article_name?.trim().toLowerCase() ?? "";
        if (rowArticleName && rowArticleName === targetArticleName) {
          matchedInvoiceNumbers.add(invoiceNumber);
        }
      }
    }

    const matchingInvoices = scopedInvoices.filter((invoice) => {
      const documentNumber = invoice.document_number?.trim();
      return documentNumber ? matchedInvoiceNumbers.has(documentNumber) : false;
    });

    setInvoiceDetailsRows(
      mapInvoicesToDetailRows(matchingInvoices, {
        fallbackDocumentNumber: "-",
        includeDueDate: true,
      }),
    );
    setInvoiceDetailsLoading(false);
  }

  async function openInvoicesStatusDialog() {
    setInvoiceDetailsMode("status-list");
    setInvoiceDetailsStatusFilter("all");
    setInvoiceDetailsOpen(true);
    setInvoiceDetailsLoading(true);
    setInvoiceDetailsRows([]);
    setInvoiceDetailsTitle(t("reports.dialogs.invoices.title", "Invoices"));

    const supabase = createClient();

    const withCustomerScope = (query: ReturnType<typeof supabase.from>) => {
      let scoped = query
        .gte("invoice_date", rollingWindow.from)
        .lte("invoice_date", rollingWindow.to);

      if (selectedCustomerId) {
        if (selectedCustomer?.fortnox_customer_number) {
          scoped = scoped.or(
            `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
          );
        } else {
          scoped = scoped.eq("customer_id", selectedCustomerId);
        }
      }

      return scoped.order("invoice_date", { ascending: false });
    };

    if (selectedCustomerId) {
      const rows = await fetchAllPages<{
        id: string;
        document_number: string | null;
        customer_name: string | null;
        invoice_date: string | null;
        due_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
        balance: number | null;
      }>(() =>
        withCustomerScope(
          supabase
            .from("invoices")
            .select(
              "id, document_number, customer_name, invoice_date, due_date, total_ex_vat, total, currency_code, balance",
            ),
        ),
      );

      setInvoiceDetailsRows(
        mapInvoicesToDetailRows(rows, {
          fallbackDocumentNumber: "-",
          includeDueDate: true,
        }),
      );
      setInvoiceDetailsLoading(false);
      return;
    }

    const customerNumbers = filteredCustomers
      .map((customer) => customer.fortnox_customer_number)
      .filter((value): value is string => Boolean(value));

    if (customerNumbers.length === 0) {
      setInvoiceDetailsRows([]);
      setInvoiceDetailsLoading(false);
      return;
    }

    const byId = new Map<string, InvoiceDetailRow>();
    for (const chunk of chunkArray(customerNumbers, 200)) {
      const rows = await fetchAllPages<{
        id: string;
        document_number: string | null;
        customer_name: string | null;
        invoice_date: string | null;
        due_date: string | null;
        total_ex_vat: number | null;
        total: number | null;
        currency_code: string | null;
        balance: number | null;
      }>(() =>
        withCustomerScope(
          supabase
            .from("invoices")
            .select(
              "id, document_number, customer_name, invoice_date, due_date, total_ex_vat, total, currency_code, balance",
            )
            .in("fortnox_customer_number", chunk),
        ),
      );

      const mapped = mapInvoicesToDetailRows(rows, {
        fallbackDocumentNumber: "-",
        includeDueDate: true,
      });
      for (const row of mapped) {
        if (!byId.has(row.id)) {
          byId.set(row.id, row);
        }
      }
    }

    setInvoiceDetailsRows(Array.from(byId.values()));
    setInvoiceDetailsLoading(false);
  }

  React.useEffect(() => {
    if (
      selectedManagerId &&
      !availableManagers.some((m) => m.id === selectedManagerId)
    ) {
      setSelectedManagerId(null);
      setSelectedCustomerId(null);
    }
  }, [availableManagers, selectedManagerId]);

  React.useEffect(() => {
    if (
      selectedCustomerId &&
      !teamScopedCustomers.some((c) => c.id === selectedCustomerId)
    ) {
      setSelectedCustomerId(null);
    }
  }, [selectedCustomerId, teamScopedCustomers]);

  const fetchReportData = React.useCallback(async () => {
    setLoading(true);
    const supabase = createClient();

    const aliasedManagerEmail =
      REPORTS_MANAGER_ALIAS[user.email.toLowerCase()] ?? null;
    let effectiveProfile: Pick<
      Profile,
      | "id"
      | "full_name"
      | "email"
      | "team_id"
      | "fortnox_cost_center"
      | "fortnox_employee_id"
      | "fortnox_user_id"
      | "fortnox_group_name"
    > = {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      team_id: user.team_id,
      fortnox_cost_center: user.fortnox_cost_center,
      fortnox_employee_id: user.fortnox_employee_id,
      fortnox_user_id: user.fortnox_user_id,
      fortnox_group_name: user.fortnox_group_name,
    };

    if (aliasedManagerEmail && user.role === "user") {
      const { data: aliasedProfile } = await supabase
        .from("profiles")
        .select(
          "id, full_name, email, team_id, fortnox_cost_center, fortnox_employee_id, fortnox_user_id, fortnox_group_name",
        )
        .ilike("email", aliasedManagerEmail)
        .limit(1)
        .maybeSingle();

      if (aliasedProfile) {
        effectiveProfile = aliasedProfile as Pick<
          Profile,
          | "id"
          | "full_name"
          | "email"
          | "team_id"
          | "fortnox_cost_center"
          | "fortnox_employee_id"
          | "fortnox_user_id"
          | "fortnox_group_name"
        >;
      }
    }

    let scopedTeams: TeamOption[] = [];
    let scopedManagers: ManagerOption[] = [];

    if (isAdmin) {
      const [{ data: teamRows }, { data: profileRows }] = await Promise.all([
        supabase.from("teams").select("id, name"),
        supabase
          .from("profiles")
          .select(
            "id, full_name, email, team_id, fortnox_cost_center, fortnox_employee_id, fortnox_user_id, fortnox_group_name",
          )
          .eq("is_active", true),
      ]);

      const allTeams = (teamRows ?? []) as TeamOption[];
      const allProfiles = (profileRows ?? []) as ManagerOption[];

      scopedTeams = allTeams.map((team) => ({ id: team.id, name: team.name }));
      scopedManagers = allProfiles;
    } else if (user.role === "team_lead") {
      const { data: ledTeamRows } = await supabase
        .from("teams")
        .select("id, name")
        .eq("lead_id", user.id);

      const ledTeams = (ledTeamRows ?? []) as TeamOption[];
      const ledTeamIds = new Set(ledTeams.map((team) => team.id));

      scopedTeams = ledTeams.map((team) => ({ id: team.id, name: team.name }));

      if (ledTeams.length > 0) {
        const { data: teamProfiles } = await supabase
          .from("profiles")
          .select(
            "id, full_name, email, team_id, fortnox_cost_center, fortnox_employee_id, fortnox_user_id, fortnox_group_name",
          )
          .eq("is_active", true)
          .in("team_id", Array.from(ledTeamIds));

        scopedManagers = (teamProfiles ?? []) as ManagerOption[];
      }
    } else {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select(
          "id, full_name, email, team_id, fortnox_cost_center, fortnox_employee_id, fortnox_user_id, fortnox_group_name",
        )
        .eq("is_active", true);

      scopedManagers = (profileRows ?? []) as ManagerOption[];
    }

    if (scopedManagers.length === 0) {
      scopedManagers = [
        {
          id: effectiveProfile.id,
          full_name: effectiveProfile.full_name,
          email: effectiveProfile.email,
          team_id: effectiveProfile.team_id,
          fortnox_cost_center: effectiveProfile.fortnox_cost_center,
          fortnox_employee_id: effectiveProfile.fortnox_employee_id,
          fortnox_user_id: effectiveProfile.fortnox_user_id,
          fortnox_group_name: effectiveProfile.fortnox_group_name,
        },
      ];
    }

    const sortedManagers = scopedManagers.sort((a, b) =>
      (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email),
    );

    const managerByCostCenter = new Map<string, ManagerOption>();
    for (const manager of sortedManagers) {
      if (
        manager.fortnox_cost_center &&
        !managerByCostCenter.has(manager.fortnox_cost_center)
      ) {
        managerByCostCenter.set(manager.fortnox_cost_center, manager);
      }
    }

    const PAGE_SIZE = 1000;
    let allCustomers: Customer[] = [];
    let from = 0;

    while (true) {
      const query = supabase
        .from("customers")
        .select("*")
        .eq("status", "active")
        .order("name")
        .range(from, from + PAGE_SIZE - 1);

      const { data } = await query;

      const rows = (data ?? []) as Customer[];
      if (rows.length === 0) break;

      allCustomers = allCustomers.concat(rows);
      if (rows.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const enrichedCustomers: CustomerWithRelations[] = allCustomers
      .map((customer) => {
        const manager = customer.fortnox_cost_center
          ? (managerByCostCenter.get(customer.fortnox_cost_center) ?? null)
          : null;

        return {
          ...customer,
          account_manager: manager
            ? {
                id: manager.id,
                full_name: manager.full_name,
                email: manager.email,
              }
            : null,
          segments: [],
        };
      })
      .filter((customer) => customer.status === "active");

    setTeams(scopedTeams);
    setManagers(sortedManagers);
    setCustomers(enrichedCustomers);

    // Populate the cross-scope directories of profile + team names. For
    // admins this is redundant with `managers`/`scopedTeams`, but cheap and
    // keeps a single code path. For team_leads / users this is what lets the
    // "Help received / Help given" sections show real names AND the manager's
    // Group column for managers outside their team scope.
    const [
      { data: directoryRows },
      { data: allTeamRows },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, email, fortnox_group_name, team_id")
        .eq("is_active", true),
      supabase.from("teams").select("id, name"),
    ]);

    const directory = new Map<
      string,
      {
        full_name: string | null
        email: string
        fortnox_group_name: string | null
        team_id: string | null
      }
    >();
    for (const row of (directoryRows ?? []) as Array<{
      id: string;
      full_name: string | null;
      email: string;
      fortnox_group_name: string | null;
      team_id: string | null;
    }>) {
      directory.set(row.id, {
        full_name: row.full_name,
        email: row.email,
        fortnox_group_name: row.fortnox_group_name,
        team_id: row.team_id,
      });
    }
    setManagerDirectory(directory);

    const teamsDir = new Map<string, string>();
    for (const row of (allTeamRows ?? []) as Array<{
      id: string;
      name: string;
    }>) {
      teamsDir.set(row.id, row.name);
    }
    setTeamNameDirectory(teamsDir);

    const savedFilters =
      hasAppliedSavedFiltersRef.current || !savedFiltersRef.current
        ? null
        : savedFiltersRef.current;

    if (savedFilters) {
      const availableTeamIds = new Set(scopedTeams.map((team) => team.id));
      const availableManagerIds = new Set(sortedManagers.map((manager) => manager.id));
      const nextTeamId =
        user.role === "user"
          ? null
          : savedFilters.selectedTeamId && availableTeamIds.has(savedFilters.selectedTeamId)
            ? savedFilters.selectedTeamId
            : user.role === "team_lead" && scopedTeams.length === 1
              ? scopedTeams[0].id
              : null;

      const managersInTeam = nextTeamId
        ? sortedManagers.filter((manager) => manager.team_id === nextTeamId)
        : sortedManagers;
      const managersInTeamSet = new Set(managersInTeam.map((manager) => manager.id));

      const nextManagerId =
        user.role === "user"
          ? effectiveProfile.id
          : savedFilters.selectedManagerId &&
              availableManagerIds.has(savedFilters.selectedManagerId) &&
              managersInTeamSet.has(savedFilters.selectedManagerId)
            ? savedFilters.selectedManagerId
            : null;

      const customersInTeam = nextTeamId
        ? enrichedCustomers.filter(
            (customer) =>
              customer.account_manager &&
              managersInTeamSet.has(customer.account_manager.id),
          )
        : enrichedCustomers;
      const customersInScope = nextManagerId
        ? customersInTeam.filter(
            (customer) => customer.account_manager?.id === nextManagerId,
          )
        : customersInTeam;
      const customersInScopeSet = new Set(customersInScope.map((customer) => customer.id));

      const nextCustomerId =
        savedFilters.selectedCustomerId && customersInScopeSet.has(savedFilters.selectedCustomerId)
          ? savedFilters.selectedCustomerId
          : null;

      setSelectedTeamId(nextTeamId);
      setSelectedManagerId(nextManagerId);
      setSelectedCustomerId(nextCustomerId);

      hasAppliedSavedFiltersRef.current = true;
    } else {
      if (user.role === "user") {
        setSelectedManagerId(effectiveProfile.id);
        setSelectedTeamId(null);
      } else if (user.role === "team_lead" && scopedTeams.length === 1) {
        setSelectedTeamId(scopedTeams[0].id);
        setSelectedManagerId(null);
      } else {
        setSelectedTeamId(null);
        setSelectedManagerId(null);
      }

      setSelectedCustomerId(null);
    }

    setLoading(false);
  }, [
    isAdmin,
    user.email,
    user.id,
    user.full_name,
    user.team_id,
    user.fortnox_cost_center,
    user.fortnox_employee_id,
    user.fortnox_user_id,
    user.fortnox_group_name,
    user.role,
  ]);

  React.useEffect(() => {
    void fetchReportData();
  }, [fetchReportData]);

  React.useEffect(() => {
    if (!customerIdFromQuery) return;
    if (!customers.some((customer) => customer.id === customerIdFromQuery)) {
      return;
    }
    setSelectedCustomerId(customerIdFromQuery);
  }, [customerIdFromQuery, customers]);

  React.useEffect(() => {
    if (loading) return;

    const payload: SavedReportsFilters = {
      selectedMonth,
      selectedWindowMode,
      selectedTeamId,
      selectedManagerId,
      selectedCustomerId,
      comparisonMode,
    };

    localStorage.setItem(REPORTS_FILTERS_STORAGE_KEY, JSON.stringify(payload));
  }, [
    comparisonMode,
    loading,
    selectedCustomerId,
    selectedManagerId,
    selectedMonth,
    selectedTeamId,
    selectedWindowMode,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchDateScopedKpis() {
      if (filteredCustomers.length === 0) {
        setKpis({ turnover: 0, invoices: 0, hours: 0, contractValue: 0 });
        setPreviousKpis(null);
        setCurrentContractValueSnapshot(null);
        setTurnoverByMonthRows(createEmptyTurnoverRows(rollingWindow.months));
        setPreviousTurnoverByMonthRows(null);
        setKpiLoading(false);
        return;
      }

      setKpiLoading(true);
      const supabase = createClient();
      const customerIds = filteredCustomers.map((customer) => customer.id);
      const customerIdChunks = chunkArray(customerIds, 200);
      const monthKeys = new Set(rollingWindow.months.map((month) => month.key));
      // Comparison is opt-in — when `none`, skip all previous-period work and
      // keep the customer_kpis query as small as possible.
      const comparisonEnabled = comparisonMode !== "none";
      const previousWindow = comparisonEnabled
        ? getPreviousReportingWindowRange(
            selectedMonth,
            selectedWindowMode,
            comparisonMode,
          )
        : null;
      const previousMonthKeys = new Set(
        previousWindow?.months.map((month) => month.key) ?? [],
      );
      // Contract value is a snapshot, not a flow — comparing the previous
      // period uses the last month of that period to avoid summing the same
      // active contract across multiple months. Same trick on the current
      // side: snapshot at the latest month of the current window so the
      // pill compares apples to apples (rollup vs rollup).
      const previousContractMonthKey =
        previousWindow?.months[previousWindow.months.length - 1]?.key ?? null;
      const currentContractMonthKey =
        rollingWindow.months[rollingWindow.months.length - 1]?.key ?? null;
      const monthNumbers = Array.from(
        new Set([
          ...rollingWindow.months.map((month) => month.month),
          ...(previousWindow?.months.map((month) => month.month) ?? []),
        ]),
      );
      const years = Array.from(
        new Set([
          ...rollingWindow.months.map((month) => month.year),
          ...(previousWindow?.months.map((month) => month.year) ?? []),
        ]),
      );

      let turnover = 0;
      let invoiceCount = 0;
      let hours = 0;
      let contractValue = 0;
      let currentContractSnapshot = 0;
      let prevTurnover = 0;
      let prevInvoiceCount = 0;
      let prevHours = 0;
      let prevContractValue = 0;
      const turnoverByMonth = new Map<string, TurnoverMonthRow>();
      for (const row of createEmptyTurnoverRows(rollingWindow.months)) {
        turnoverByMonth.set(row.monthKey, row);
      }
      const previousTurnoverByMonth = new Map<string, TurnoverMonthRow>();
      if (previousWindow) {
        for (const row of createEmptyTurnoverRows(previousWindow.months)) {
          previousTurnoverByMonth.set(row.monthKey, row);
        }
      }

      for (const idChunk of customerIdChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{
          period_year: number;
          period_month: number;
          total_turnover: number | null;
          invoice_count: number | null;
          total_hours: number | null;
          contract_value: number | null;
        }>(() =>
          supabase
            .from("customer_kpis")
            .select(
              "period_year, period_month, total_turnover, invoice_count, total_hours, contract_value",
            )
            .in("customer_id", idChunk)
            .eq("period_type", "month")
            .in("period_year", years)
            .in("period_month", monthNumbers),
        );

        for (const row of rows) {
          const monthKey = `${row.period_year}-${String(row.period_month).padStart(2, "0")}`;

          if (monthKeys.has(monthKey)) {
            turnover += Number(row.total_turnover ?? 0);
            invoiceCount += Number(row.invoice_count ?? 0);
            hours += Number(row.total_hours ?? 0);

            if (monthKey === currentContractMonthKey) {
              currentContractSnapshot += Number(row.contract_value ?? 0);
            }

            const target = turnoverByMonth.get(monthKey);
            if (target) {
              target.turnover += Number(row.total_turnover ?? 0);
              target.invoiceCount += Number(row.invoice_count ?? 0);
            }
          } else if (previousMonthKeys.has(monthKey)) {
            prevTurnover += Number(row.total_turnover ?? 0);
            prevInvoiceCount += Number(row.invoice_count ?? 0);
            prevHours += Number(row.total_hours ?? 0);
            if (monthKey === previousContractMonthKey) {
              prevContractValue += Number(row.contract_value ?? 0);
            }

            const prevTarget = previousTurnoverByMonth.get(monthKey);
            if (prevTarget) {
              prevTarget.turnover += Number(row.total_turnover ?? 0);
              prevTarget.invoiceCount += Number(row.invoice_count ?? 0);
            }
          }
        }
      }

      const contractCustomerNumbers = Array.from(
        new Set(
          filteredCustomers
            .map((customer) => customer.fortnox_customer_number)
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const contractCustomerNumberChunks = chunkArray(
        contractCustomerNumbers,
        200,
      );

      for (const numberChunk of contractCustomerNumberChunks) {
        if (cancelled) return;

        const { data: contractRows, error: contractError } = await supabase
          .from("contract_accruals")
          .select("total_ex_vat, total, period")
          .in("fortnox_customer_number", numberChunk)
          .eq("is_active", true);

        if (contractError) {
          throw contractError;
        }

        const rows = (contractRows ?? []) as Array<{
          total_ex_vat: number | null;
          total: number | null;
          period: string | null;
        }>;

        for (const row of rows) {
          contractValue += annualizeContractTotal(row.total_ex_vat, row.period);
        }
      }

      if (cancelled) return;

      setKpis({
        turnover,
        invoices: invoiceCount,
        hours,
        contractValue,
      });
      if (comparisonEnabled) {
        setPreviousKpis({
          turnover: prevTurnover,
          invoices: prevInvoiceCount,
          hours: prevHours,
          contractValue: prevContractValue,
        });
        setCurrentContractValueSnapshot(currentContractSnapshot);
      } else {
        setPreviousKpis(null);
        setCurrentContractValueSnapshot(null);
      }
      setTurnoverByMonthRows(
        rollingWindow.months.map(
          (month) =>
            turnoverByMonth.get(month.key) ?? {
              monthKey: month.key,
              monthLabel: month.label,
              turnover: 0,
              invoiceCount: 0,
            },
        ),
      );
      setPreviousTurnoverByMonthRows(
        comparisonEnabled && previousWindow
          ? previousWindow.months.map(
              (month) =>
                previousTurnoverByMonth.get(month.key) ?? {
                  monthKey: month.key,
                  monthLabel: `${month.label} ${String(month.year).slice(-2)}`,
                  turnover: 0,
                  invoiceCount: 0,
                },
            )
          : null,
      );
      setKpiLoading(false);
    }

    fetchDateScopedKpis().catch(() => {
      if (!cancelled) {
        setKpis({ turnover: 0, invoices: 0, hours: 0, contractValue: 0 });
        setPreviousKpis(null);
        setCurrentContractValueSnapshot(null);
        setTurnoverByMonthRows(createEmptyTurnoverRows(rollingWindow.months));
        setPreviousTurnoverByMonthRows(null);
        setKpiLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [comparisonMode, filteredCustomers, rollingWindow, selectedMonth, selectedWindowMode]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchMonthlyTimeReporting() {
      if (selectedCustomerId) {
        setMonthlyTimeReportingRows([]);
        setMonthlyTimeReportingLoading(false);
        return;
      }

      if (!selectedManagerId && filteredCustomers.length === 0) {
        setMonthlyTimeReportingRows([]);
        setMonthlyTimeReportingLoading(false);
        return;
      }

      setMonthlyTimeReportingLoading(true);
      const supabase = createClient();
      const rowsByMonth = new Map<string, MonthlyTimeReportingRow>();
      for (const row of createEmptyMonthlyTimeReportingRows(
        rollingWindow.months,
      )) {
        rowsByMonth.set(row.monthKey, row);
      }

      const monthNumbers = Array.from(
        new Set(rollingWindow.months.map((month) => month.month)),
      );
      const years = Array.from(
        new Set(rollingWindow.months.map((month) => month.year)),
      );

      if (selectedManagerId) {
        const { data, error } = await supabase
          .from("manager_time_kpis")
          .select(
            "period_year, period_month, customer_hours, absence_hours, internal_hours, other_hours, total_hours",
          )
          .eq("manager_profile_id", selectedManagerId)
          .in("period_year", years)
          .in("period_month", monthNumbers);

        if (error) {
          throw error;
        }

        const rows = (data ?? []) as Array<{
          period_year: number;
          period_month: number;
          customer_hours: number | null;
          absence_hours: number | null;
          internal_hours: number | null;
          other_hours: number | null;
          total_hours: number | null;
        }>;

        for (const row of rows) {
          const monthKey = `${row.period_year}-${String(row.period_month).padStart(2, "0")}`;
          const target = rowsByMonth.get(monthKey);
          if (!target) continue;

          const customerHours = Number(row.customer_hours ?? 0);
          const absenceHours = Number(row.absence_hours ?? 0);
          const internalHours = Number(row.internal_hours ?? 0);
          const totalHours = Number(
            row.total_hours ??
              customerHours +
                absenceHours +
                internalHours +
                Number(row.other_hours ?? 0),
          );

          target.customerHours += customerHours;
          target.absenceHours += absenceHours;
          target.internalHours += internalHours;
          target.totalHours += totalHours;
        }
      } else {
        const customerIds = filteredCustomers.map((customer) => customer.id);
        const customerIdChunks = chunkArray(customerIds, 200);

        for (const idChunk of customerIdChunks) {
          if (cancelled) return;

          const rows = await fetchAllPages<{
            period_year: number;
            period_month: number;
            customer_hours: number | null;
            absence_hours: number | null;
            internal_hours: number | null;
          }>(() =>
            supabase
              .from("customer_kpis")
              .select(
                "period_year, period_month, customer_hours, absence_hours, internal_hours",
              )
              .in("customer_id", idChunk)
              .eq("period_type", "month")
              .in("period_year", years)
              .in("period_month", monthNumbers),
          );

          for (const row of rows) {
            const monthKey = `${row.period_year}-${String(row.period_month).padStart(2, "0")}`;
            const target = rowsByMonth.get(monthKey);
            if (!target) continue;

            const customerHours = Number(row.customer_hours ?? 0);
            const absenceHours = Number(row.absence_hours ?? 0);
            const internalHours = Number(row.internal_hours ?? 0);

            target.customerHours += customerHours;
            target.absenceHours += absenceHours;
            target.internalHours += internalHours;
            target.totalHours += customerHours + absenceHours + internalHours;
          }
        }
      }

      if (cancelled) return;

      const orderedRows = [...rollingWindow.months].reverse().map(
        (month) =>
          rowsByMonth.get(month.key) ?? {
            monthKey: month.key,
            monthLabel: month.label,
            customerHours: 0,
            absenceHours: 0,
            internalHours: 0,
            totalHours: 0,
          },
      );

      setMonthlyTimeReportingRows(orderedRows);
      setMonthlyTimeReportingLoading(false);
    }

    fetchMonthlyTimeReporting().catch(() => {
      if (!cancelled) {
        setMonthlyTimeReportingRows([]);
        setMonthlyTimeReportingLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filteredCustomers, rollingWindow, selectedCustomerId, selectedManagerId]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchOtherManagersOnSelectedCustomers() {
      if (
        !selectedManagerId ||
        selectedCustomerId ||
        filteredCustomers.length === 0
      ) {
        setOtherManagersTimeReportingRows([]);
        setOtherManagersTimeReportingLoading(false);
        return;
      }

      setOtherManagersTimeReportingLoading(true);
      const supabase = createClient();
      const monthNumbers = Array.from(
        new Set(rollingWindow.months.map((month) => month.month)),
      );
      const years = Array.from(
        new Set(rollingWindow.months.map((month) => month.year)),
      );

      const { data, error } = await supabase
        .from("manager_time_kpis")
        .select("manager_profile_id, customer_hours, period_year, period_month")
        .eq("customer_manager_profile_id", selectedManagerId)
        .neq("manager_profile_id", selectedManagerId)
        .in("period_year", years)
        .in("period_month", monthNumbers);

      if (error) {
        setOtherManagersTimeReportingRows([]);
        setOtherManagersTimeReportingLoading(false);
        return;
      }

      const rows = (data ?? []) as Array<{
        manager_profile_id: string;
        customer_hours: number | null;
        period_year: number;
        period_month: number;
      }>;

      const byContributor = new Map<string, CustomerTimeReportingRow>();

      for (const row of rows) {
        const manager = managerById.get(row.manager_profile_id);
        // Fall back to the cross-scope directory when the scoped lookup
        // misses (team_leads / users see managers outside their team here).
        const directoryEntry = !manager
          ? managerDirectory.get(row.manager_profile_id)
          : undefined;
        const displayContributorName =
          manager?.full_name?.trim() ||
          manager?.email ||
          directoryEntry?.full_name?.trim() ||
          directoryEntry?.email ||
          t("reports.unknown", "Unknown");
        const contributorId =
          normalizeIdentifier(manager?.fortnox_user_id) ||
          normalizeIdentifier(manager?.fortnox_employee_id) ||
          null;
        const key = `${row.manager_profile_id}:${displayContributorName}`;
        // Resolve the group column with a flexible fallback chain. Team name
        // lookups always check both teamNameById (scoped — populated for
        // admins / team_leads) and teamNameDirectory (full — populated for
        // every role) so regular users (whose teamNameById is empty by
        // design) still resolve group names correctly.
        const teamIdToResolve = manager?.team_id ?? directoryEntry?.team_id ?? null;
        const groupName =
          manager?.fortnox_group_name ??
          directoryEntry?.fortnox_group_name ??
          (teamIdToResolve
            ? (teamNameById.get(teamIdToResolve) ??
                teamNameDirectory.get(teamIdToResolve) ??
                "-")
            : "-");
        const target = byContributor.get(key) ?? {
          contributorKey: key,
          managerProfileId: row.manager_profile_id,
          contributorId,
          contributorName: displayContributorName,
          groupName,
          customerHours: 0,
          workloadPercentage: 0,
        };

        target.customerHours += Number(row.customer_hours ?? 0);
        byContributor.set(key, target);
      }

      const totals = Array.from(byContributor.values());
      const totalCustomerHours = totals.reduce(
        (sum, reportRow) => sum + reportRow.customerHours,
        0,
      );

      const finalRows = totals
        .map((reportRow) => ({
          ...reportRow,
          workloadPercentage:
            totalCustomerHours > 0
              ? (reportRow.customerHours / totalCustomerHours) * 100
              : 0,
        }))
        .sort((a, b) => b.customerHours - a.customerHours);

      if (cancelled) return;

      setOtherManagersTimeReportingRows(finalRows);
      setOtherManagersTimeReportingLoading(false);
    }

    fetchOtherManagersOnSelectedCustomers().catch(() => {
      if (!cancelled) {
        setOtherManagersTimeReportingRows([]);
        setOtherManagersTimeReportingLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    filteredCustomers,
    managerById,
    managerDirectory,
    rollingWindow,
    selectedCustomerId,
    selectedManagerId,
    t,
    teamNameById,
    teamNameDirectory,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchHelpedCustomerManagers() {
      if (!selectedManagerId || selectedCustomerId) {
        setHelpedCustomerManagersRows([]);
        setHelpedCustomerManagersLoading(false);
        return;
      }

      setHelpedCustomerManagersLoading(true);

      const monthNumbers = Array.from(
        new Set(rollingWindow.months.map((month) => month.month)),
      );
      const years = Array.from(
        new Set(rollingWindow.months.map((month) => month.year)),
      );

      const { data, error } = await createClient()
        .from("manager_time_kpis")
        .select(
          "customer_manager_profile_id, customer_hours, period_year, period_month",
        )
        .eq("manager_profile_id", selectedManagerId)
        .neq("customer_manager_profile_id", selectedManagerId)
        .not("customer_manager_profile_id", "is", null)
        .in("period_year", years)
        .in("period_month", monthNumbers);

      if (error) {
        setHelpedCustomerManagersRows([]);
        setHelpedCustomerManagersLoading(false);
        return;
      }

      const rows = (data ?? []) as Array<{
        customer_manager_profile_id: string;
        customer_hours: number | null;
        period_year: number;
        period_month: number;
      }>;

      const monthKeys = new Set(rollingWindow.months.map((month) => month.key));
      const totalsByManager = new Map<string, HelpedCustomerManagerRow>();

      for (const row of rows) {
        const monthKey = `${row.period_year}-${String(row.period_month).padStart(2, "0")}`;
        if (!monthKeys.has(monthKey)) continue;

        const manager = managerById.get(row.customer_manager_profile_id);
        // Same fallback as the other cross-manager section — names should
        // resolve even when the manager is outside the user's scoped list.
        const directoryEntry = !manager
          ? managerDirectory.get(row.customer_manager_profile_id)
          : undefined;
        const managerName =
          manager?.full_name?.trim() ||
          manager?.email ||
          directoryEntry?.full_name?.trim() ||
          directoryEntry?.email ||
          t("reports.unknown", "Unknown");
        // Same flexible fallback as the other cross-manager section — always
        // try teamNameDirectory if teamNameById misses, so regular users
        // (who have an empty teamNameById by design) still get group names.
        const teamIdToResolve = manager?.team_id ?? directoryEntry?.team_id ?? null;
        const groupName =
          manager?.fortnox_group_name ??
          directoryEntry?.fortnox_group_name ??
          (teamIdToResolve
            ? (teamNameById.get(teamIdToResolve) ??
                teamNameDirectory.get(teamIdToResolve) ??
                "-")
            : "-");
        const current = totalsByManager.get(
          row.customer_manager_profile_id,
        ) ?? {
          managerProfileId: row.customer_manager_profile_id,
          managerName,
          groupName,
          customerHours: 0,
          workloadPercentage: 0,
        };

        current.customerHours += Number(row.customer_hours ?? 0);
        totalsByManager.set(row.customer_manager_profile_id, current);
      }

      const totalHours = Array.from(totalsByManager.values()).reduce(
        (sum, row) => sum + row.customerHours,
        0,
      );

      const finalRows = Array.from(totalsByManager.values())
        .filter((row) => row.customerHours > 0)
        .map((row) => ({
          ...row,
          workloadPercentage:
            totalHours > 0 ? (row.customerHours / totalHours) * 100 : 0,
        }))
        .sort((a, b) => b.customerHours - a.customerHours);

      if (cancelled) return;

      setHelpedCustomerManagersRows(finalRows);
      setHelpedCustomerManagersLoading(false);
    }

    fetchHelpedCustomerManagers().catch(() => {
      if (!cancelled) {
        setHelpedCustomerManagersRows([]);
        setHelpedCustomerManagersLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    managerById,
    managerDirectory,
    rollingWindow,
    selectedCustomerId,
    selectedManagerId,
    t,
    teamNameDirectory,
    teamNameById,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchManagerCustomerSummary() {
      if (
        !selectedManagerId ||
        selectedCustomerId ||
        filteredCustomers.length === 0
      ) {
        setManagerCustomerSummaryRows([]);
        setManagerCustomerSummaryLoading(false);
        return;
      }

      setManagerCustomerSummaryLoading(true);

      const supabase = createClient();
      const customerIds = filteredCustomers.map((customer) => customer.id);
      const customerIdChunks = chunkArray(customerIds, 200);
      const monthNumbers = Array.from(
        new Set(rollingWindow.months.map((month) => month.month)),
      );
      const years = Array.from(
        new Set(rollingWindow.months.map((month) => month.year)),
      );
      const monthKeys = new Set(rollingWindow.months.map((month) => month.key));

      const customerNameById = new Map(
        filteredCustomers.map((customer) => [customer.id, customer.name]),
      );
      const totalsByCustomer = new Map<string, ManagerCustomerSummaryRow>();
      const createEmptySummaryRow = (customerId: string): ManagerCustomerSummaryRow => ({
        customerId,
        customerName: customerNameById.get(customerId) ?? customerId,
        turnover: 0,
        invoiceCount: 0,
        contractValue: 0,
        workloadPercentage: 0,
        customerHours: 0,
      });

      for (const idChunk of customerIdChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{
          customer_id: string;
          period_year: number;
          period_month: number;
          invoice_count: number | null;
          customer_hours: number | null;
        }>(() =>
          supabase
            .from("customer_kpis")
            .select(
              "customer_id, period_year, period_month, invoice_count, customer_hours",
            )
            .in("customer_id", idChunk)
            .eq("period_type", "month")
            .in("period_year", years)
            .in("period_month", monthNumbers),
        );

        for (const row of rows) {
          const monthKey = `${row.period_year}-${String(row.period_month).padStart(2, "0")}`;
          if (!monthKeys.has(monthKey)) continue;

          const current =
            totalsByCustomer.get(row.customer_id) ??
            createEmptySummaryRow(row.customer_id);

          current.invoiceCount += Number(row.invoice_count ?? 0);
          current.customerHours += Number(row.customer_hours ?? 0);

          totalsByCustomer.set(row.customer_id, current);
        }
      }

      const invoicesSeen = new Set<string>();
      const customerNumberById = new Map(
        filteredCustomers
          .filter((customer) => Boolean(customer.fortnox_customer_number))
          .map((customer) => [customer.id, customer.fortnox_customer_number as string]),
      );
      const customerIdsByNumber = new Map<string, string[]>();
      for (const [customerId, customerNumber] of customerNumberById.entries()) {
        const existing = customerIdsByNumber.get(customerNumber) ?? [];
        existing.push(customerId);
        customerIdsByNumber.set(customerNumber, existing);
      }

      for (const idChunk of customerIdChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{
          id: string;
          customer_id: string | null;
          total_ex_vat: number | null;
        }>(() =>
          supabase
            .from("invoices")
            .select("id, customer_id, total_ex_vat")
            .in("customer_id", idChunk)
            .gte("invoice_date", rollingWindow.from)
            .lte("invoice_date", rollingWindow.to),
        );

        for (const row of rows) {
          if (!row.customer_id) continue;
          invoicesSeen.add(row.id);

          const current =
            totalsByCustomer.get(row.customer_id) ??
            createEmptySummaryRow(row.customer_id);
          current.turnover += Number(row.total_ex_vat ?? 0);
          totalsByCustomer.set(row.customer_id, current);
        }
      }

      const customerNumberChunks = chunkArray(
        Array.from(customerIdsByNumber.keys()),
        200,
      );

      for (const numberChunk of customerNumberChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{
          id: string;
          customer_id: string | null;
          fortnox_customer_number: string | null;
          total_ex_vat: number | null;
        }>(() =>
          supabase
            .from("invoices")
            .select("id, customer_id, fortnox_customer_number, total_ex_vat")
            .in("fortnox_customer_number", numberChunk)
            .gte("invoice_date", rollingWindow.from)
            .lte("invoice_date", rollingWindow.to),
        );

        for (const row of rows) {
          if (invoicesSeen.has(row.id)) continue;
          invoicesSeen.add(row.id);

          const customerNumber = row.fortnox_customer_number;
          if (!customerNumber) continue;

          const targetCustomerIds = customerIdsByNumber.get(customerNumber);
          if (!targetCustomerIds || targetCustomerIds.length === 0) continue;

          const amount = Number(row.total_ex_vat ?? 0);

          for (const customerId of targetCustomerIds) {
            const current =
              totalsByCustomer.get(customerId) ??
              createEmptySummaryRow(customerId);
            current.turnover += amount;
            totalsByCustomer.set(customerId, current);
          }
        }
      }

      const contractCustomerNumberById = new Map(
        filteredCustomers
          .filter((customer) => Boolean(customer.fortnox_customer_number))
          .map((customer) => [customer.id, customer.fortnox_customer_number as string]),
      );
      const customerIdsByContractNumber = new Map<string, string[]>();
      for (const [customerId, contractNumber] of contractCustomerNumberById.entries()) {
        const existing = customerIdsByContractNumber.get(contractNumber) ?? [];
        existing.push(customerId);
        customerIdsByContractNumber.set(contractNumber, existing);
      }

      const contractCustomerNumberChunks = chunkArray(
        Array.from(customerIdsByContractNumber.keys()),
        200,
      );

      for (const numberChunk of contractCustomerNumberChunks) {
        if (cancelled) return;

        const { data, error } = await supabase
          .from("contract_accruals")
          .select("fortnox_customer_number, total_ex_vat, total, period")
          .in("fortnox_customer_number", numberChunk)
          .eq("is_active", true);

        if (error) {
          setManagerCustomerSummaryRows([]);
          setManagerCustomerSummaryLoading(false);
          return;
        }

        const rows = (data ?? []) as Array<{
          fortnox_customer_number: string | null;
          total_ex_vat: number | null;
          total: number | null;
          period: string | null;
        }>;

        for (const row of rows) {
          const contractNumber = row.fortnox_customer_number;
          if (!contractNumber) continue;

          const targetCustomerIds = customerIdsByContractNumber.get(contractNumber);
          if (!targetCustomerIds || targetCustomerIds.length === 0) continue;

          const annualized = annualizeContractTotal(row.total_ex_vat, row.period);

          for (const customerId of targetCustomerIds) {
            const current =
              totalsByCustomer.get(customerId) ??
              createEmptySummaryRow(customerId);

            current.contractValue += annualized;
            totalsByCustomer.set(customerId, current);
          }
        }
      }

      const totalHours = Array.from(totalsByCustomer.values()).reduce(
        (sum, row) => sum + row.customerHours,
        0,
      );

      const finalRows = Array.from(totalsByCustomer.values())
        .map((row) => ({
          ...row,
          workloadPercentage:
            totalHours > 0 ? (row.customerHours / totalHours) * 100 : 0,
        }))
        .sort((a, b) => b.turnover - a.turnover);

      if (cancelled) return;

      setManagerCustomerSummaryRows(finalRows);
      setManagerCustomerSummaryLoading(false);
    }

    fetchManagerCustomerSummary().catch(() => {
      if (!cancelled) {
        setManagerCustomerSummaryRows([]);
        setManagerCustomerSummaryLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filteredCustomers, rollingWindow, selectedCustomerId, selectedManagerId]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchCustomerTimeReporting() {
      if (!selectedCustomerId) {
        setCustomerTimeReportingRows([]);
        setCustomerTimeReportingLoading(false);
        return;
      }

      setCustomerTimeReportingLoading(true);
      const supabase = createClient();
      let query = supabase
        .from("time_reports")
        .select("employee_id, employee_name, entry_type, hours")
        .gte("report_date", rollingWindow.from)
        .lte("report_date", rollingWindow.to);

      if (selectedCustomer?.fortnox_customer_number) {
        query = query.or(
          `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
        );
      } else {
        query = query.eq("customer_id", selectedCustomerId);
      }

      const { data, error } = await query;

      if (cancelled) return;

      if (error) {
        setCustomerTimeReportingRows([]);
        setCustomerTimeReportingLoading(false);
        return;
      }

      const rows = (data ?? []) as Array<{
        employee_id: string | null;
        employee_name: string | null;
        entry_type: string | null;
        hours: number | null;
      }>;

      const byContributor = new Map<string, CustomerTimeReportingRow>();

      for (const row of rows) {
        const entryType = normalizeText(row.entry_type);
        if (entryType !== "time") continue;

        const sourceEmployeeId = row.employee_id;
        const normalizedEmployeeId = normalizeIdentifier(sourceEmployeeId);
        const contributorName = row.employee_name?.trim()
          ? row.employee_name.trim()
          : normalizedEmployeeId
            ? `${t("reports.unknown", "Unknown")} (ID: ${normalizedEmployeeId})`
            : t("reports.unknown", "Unknown");
        const byUserId = normalizedEmployeeId
          ? managerByFortnoxUserId.get(normalizedEmployeeId)
          : undefined;
        const byEmployeeId = normalizedEmployeeId
          ? managerByFortnoxEmployeeId.get(normalizedEmployeeId)
          : undefined;
        const byName = managerByName.get(normalizeText(contributorName));
        const managerMatch = byUserId ?? byEmployeeId ?? byName;
        const mappedContributorName = managerMatch?.full_name?.trim() ?? null;
        const displayContributorName = mappedContributorName ?? contributorName;
        const contributorId =
          normalizeIdentifier(managerMatch?.fortnox_user_id) ||
          normalizedEmployeeId ||
          null;
        const key = `${contributorId ?? "none"}:${displayContributorName}`;
        const groupName =
          managerMatch?.fortnox_group_name ??
          (managerMatch?.team_id
            ? (teamNameById.get(managerMatch.team_id) ?? "-")
            : "-");
        const target = byContributor.get(key) ?? {
          contributorKey: key,
          managerProfileId: managerMatch?.id ?? null,
          contributorId,
          contributorName: displayContributorName,
          groupName,
          customerHours: 0,
          workloadPercentage: 0,
        };

        target.customerHours += Number(row.hours ?? 0);
        byContributor.set(key, target);
      }

      const totals = Array.from(byContributor.values());
      const totalCustomerHours = totals.reduce(
        (sum, row) => sum + row.customerHours,
        0,
      );

      const finalRows = totals
        .map((row) => ({
          ...row,
          workloadPercentage:
            totalCustomerHours > 0
              ? (row.customerHours / totalCustomerHours) * 100
              : 0,
        }))
        .sort((a, b) => b.customerHours - a.customerHours);

      setCustomerTimeReportingRows(finalRows);
      setCustomerTimeReportingLoading(false);
    }

    fetchCustomerTimeReporting().catch(() => {
      if (!cancelled) {
        setCustomerTimeReportingRows([]);
        setCustomerTimeReportingLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    selectedCustomerId,
    selectedCustomer,
    rollingWindow,
    managerByFortnoxUserId,
    managerByFortnoxEmployeeId,
    managerByName,
    t,
    teamNameById,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchCustomerAccruals() {
      if (!selectedCustomerId || !selectedCustomer?.fortnox_customer_number) {
        setCustomerAccruals([]);
        setAccrualsLoading(false);
        return;
      }

      setAccrualsLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contract_accruals")
        .select("*")
        .eq("fortnox_customer_number", selectedCustomer.fortnox_customer_number)
        .order("start_date", { ascending: true });

      if (cancelled) return;

      if (error) {
        setCustomerAccruals([]);
        setAccrualsLoading(false);
        return;
      }

      setCustomerAccruals((data ?? []) as ContractAccrual[]);
      setAccrualsLoading(false);
    }

    fetchCustomerAccruals().catch(() => {
      if (!cancelled) {
        setCustomerAccruals([]);
        setAccrualsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedCustomerId, selectedCustomer?.fortnox_customer_number]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchCustomerMonthlyEconomicsSource() {
      if (!selectedCustomerId) {
        setCustomerMonthlyEconomicsRows([]);
        setMonthlyInvoiceGroupRows([]);
        setMonthlyHourGroupRows([]);
        setMonthlyArticleGroupValues([]);
        setSelectedMonthlyArticleGroups([]);
        setCustomerMonthlyEconomicsLoading(false);
        return;
      }

      setCustomerMonthlyEconomicsLoading(true);
      const supabase = createClient();

      let invoiceQuery = supabase
        .from("invoices")
        .select("document_number, invoice_date")
        .gte("invoice_date", rollingWindow.from)
        .lte("invoice_date", rollingWindow.to);

      if (selectedCustomer?.fortnox_customer_number) {
        invoiceQuery = invoiceQuery.or(
          `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
        );
      } else {
        invoiceQuery = invoiceQuery.eq("customer_id", selectedCustomerId);
      }

      const { data: invoiceRows, error: invoiceError } = await invoiceQuery;
      if (cancelled) return;

      if (invoiceError) {
        setCustomerMonthlyEconomicsRows([]);
        setMonthlyInvoiceGroupRows([]);
        setMonthlyHourGroupRows([]);
        setMonthlyArticleGroupValues([]);
        setSelectedMonthlyArticleGroups([]);
        setCustomerMonthlyEconomicsLoading(false);
        return;
      }

      const invoiceMonthByNumber = new Map<string, string>();
      const invoiceNumbers: string[] = [];
      for (const row of (invoiceRows ?? []) as Array<{
        document_number: string | null;
        invoice_date: string | null;
      }>) {
        const invoiceNumber = normalizeIdentifier(row.document_number);
        const monthKey = (row.invoice_date ?? "").slice(0, 7);
        if (!invoiceNumber || !monthKey) continue;
        invoiceMonthByNumber.set(invoiceNumber, monthKey);
        invoiceNumbers.push(invoiceNumber);
      }

      const uniqueInvoiceNumbers = Array.from(new Set(invoiceNumbers));
      const invoiceNumberChunks = chunkArray(uniqueInvoiceNumbers, 200);

      const mappingByArticleNumber = new Map<
        string,
        { groupName: string; articleName: string | null }
      >();
      const mappingByArticleName = new Map<
        string,
        { groupName: string; articleName: string | null }
      >();

      const { data: mappings, error: mappingError } = await supabase
        .from("article_group_mappings")
        .select("article_number, article_name, group_name, active")
        .eq("active", true);

      if (cancelled) return;

      if (mappingError) {
        setCustomerMonthlyEconomicsRows([]);
        setMonthlyInvoiceGroupRows([]);
        setMonthlyHourGroupRows([]);
        setMonthlyArticleGroupValues([]);
        setSelectedMonthlyArticleGroups([]);
        setCustomerMonthlyEconomicsLoading(false);
        return;
      }

      for (const mappingRow of (mappings ?? []) as Array<{
        article_number: string | null;
        article_name: string | null;
        group_name: string;
        active: boolean | null;
      }>) {
        if (!mappingRow.group_name) continue;
        const normalizedArticleNumber = normalizeIdentifier(
          mappingRow.article_number,
        );
        const normalizedArticleName = normalizeText(mappingRow.article_name);
        const mapped = {
          groupName: mappingRow.group_name,
          articleName: mappingRow.article_name,
        };

        if (normalizedArticleNumber) {
          mappingByArticleNumber.set(normalizedArticleNumber, mapped);
        }
        if (normalizedArticleName) {
          mappingByArticleName.set(normalizedArticleName, mapped);
        }
      }

      const groupedInvoiceRows: MonthlyInvoiceGroupRow[] = [];
      const groupValueSet = new Set<string>();

      for (const invoiceNumberChunk of invoiceNumberChunks) {
        if (cancelled) return;

        const invoiceRows = await fetchAllPages<{
          invoice_number: string | null;
          article_number: string | null;
          article_name: string | null;
          total_ex_vat: number | null;
        }>(() =>
          supabase
            .from("invoice_rows")
            .select("invoice_number, article_number, article_name, total_ex_vat")
            .in("invoice_number", invoiceNumberChunk),
        );

        for (const row of invoiceRows) {
          const invoiceNumber = normalizeIdentifier(row.invoice_number);
          const monthKey = invoiceMonthByNumber.get(invoiceNumber);
          if (!monthKey) continue;

          const normalizedArticleNumber = normalizeIdentifier(row.article_number);
          const normalizedArticleName = normalizeText(row.article_name);
          const mapping =
            (normalizedArticleNumber
              ? mappingByArticleNumber.get(normalizedArticleNumber)
              : null) ??
            (normalizedArticleName
              ? mappingByArticleName.get(normalizedArticleName)
              : null);

          const groupValue =
            mapping?.groupName?.trim().length
              ? mapping.groupName.trim()
              : MONTHLY_UNMAPPED_ARTICLE_GROUP;

          groupedInvoiceRows.push({
            monthKey,
            groupValue,
            turnover: Number(row.total_ex_vat ?? 0),
          });
          groupValueSet.add(groupValue);
        }
      }

      setMonthlyInvoiceGroupRows(groupedInvoiceRows);

      let hoursQuery = supabase
        .from("time_reports")
        .select("report_date, hours, article_number")
        .eq("entry_type", "time")
        .gte("report_date", rollingWindow.from)
        .lte("report_date", rollingWindow.to);

      if (selectedCustomer?.fortnox_customer_number) {
        hoursQuery = hoursQuery.or(
          `customer_id.eq.${selectedCustomerId},fortnox_customer_number.eq.${selectedCustomer.fortnox_customer_number}`,
        );
      } else {
        hoursQuery = hoursQuery.eq("customer_id", selectedCustomerId);
      }

      const { data: hourRows, error: hourError } = await hoursQuery;
      if (cancelled) return;

      if (hourError) {
        setCustomerMonthlyEconomicsRows([]);
        setMonthlyInvoiceGroupRows([]);
        setMonthlyHourGroupRows([]);
        setMonthlyArticleGroupValues([]);
        setSelectedMonthlyArticleGroups([]);
        setCustomerMonthlyEconomicsLoading(false);
        return;
      }

      const groupedHourRows: MonthlyHourGroupRow[] = [];
      for (const row of (hourRows ?? []) as Array<{
        report_date: string | null;
        hours: number | null;
        article_number: string | null;
      }>) {
        const monthKey = (row.report_date ?? "").slice(0, 7);
        if (!monthKey) continue;

        const normalizedArticleNumber = normalizeIdentifier(row.article_number);
        const mapping = normalizedArticleNumber
          ? mappingByArticleNumber.get(normalizedArticleNumber)
          : null;
        const groupValue =
          mapping?.groupName?.trim().length
            ? mapping.groupName.trim()
            : MONTHLY_UNMAPPED_ARTICLE_GROUP;

        groupedHourRows.push({
          monthKey,
          groupValue,
          hours: Number(row.hours ?? 0),
        });
        groupValueSet.add(groupValue);
      }

      const nextGroupValues = Array.from(groupValueSet.values()).sort((a, b) =>
        monthlyArticleGroupLabel(a).localeCompare(monthlyArticleGroupLabel(b)),
      );
      const defaultSelected = nextGroupValues.filter(
        (groupValue) => groupValue !== MONTHLY_DEFAULT_EXCLUDED_ARTICLE_GROUP,
      );
      const fallbackSelected =
        defaultSelected.length > 0 ? defaultSelected : nextGroupValues;

      setMonthlyHourGroupRows(groupedHourRows);
      setMonthlyArticleGroupValues(nextGroupValues);
      setSelectedMonthlyArticleGroups((current) => {
        const inScope = current.filter((value) =>
          nextGroupValues.includes(value),
        );
        const next = inScope.length > 0 ? inScope : fallbackSelected;
        if (
          current.length === next.length &&
          current.every((value, index) => value === next[index])
        ) {
          return current;
        }
        return next;
      });
      setCustomerMonthlyEconomicsLoading(false);
    }

    fetchCustomerMonthlyEconomicsSource().catch(() => {
      if (!cancelled) {
        setCustomerMonthlyEconomicsRows([]);
        setMonthlyInvoiceGroupRows([]);
        setMonthlyHourGroupRows([]);
        setMonthlyArticleGroupValues([]);
        setSelectedMonthlyArticleGroups([]);
        setCustomerMonthlyEconomicsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    monthlyArticleGroupLabel,
    rollingWindow,
    selectedCustomer,
    selectedCustomerId,
  ]);

  React.useEffect(() => {
    if (!selectedCustomerId) {
      setCustomerMonthlyEconomicsRows([]);
      return;
    }

    const rowsByMonth = new Map<string, CustomerMonthlyEconomicsRow>();
    for (const month of rollingWindow.months) {
      rowsByMonth.set(month.key, {
        monthKey: month.key,
        monthLabel: `${month.label} ${String(month.year).slice(-2)}`,
        turnover: 0,
        turnoverFromTotal: false,
        hours: 0,
        turnoverPerHour: null,
      });
    }

    for (const row of monthlyInvoiceGroupRows) {
      if (!selectedMonthlyArticleGroupSet.has(row.groupValue)) continue;
      const target = rowsByMonth.get(row.monthKey);
      if (!target) continue;
      target.turnover = Number(target.turnover ?? 0) + row.turnover;
    }

    for (const row of monthlyHourGroupRows) {
      if (!selectedMonthlyArticleGroupSet.has(row.groupValue)) continue;
      const target = rowsByMonth.get(row.monthKey);
      if (!target) continue;
      target.hours += row.hours;
    }

    const orderedRows = rollingWindow.months.map((month) => {
      const row = rowsByMonth.get(month.key) ?? {
        monthKey: month.key,
        monthLabel: `${month.label} ${String(month.year).slice(-2)}`,
        turnover: 0,
        turnoverFromTotal: false,
        hours: 0,
        turnoverPerHour: null,
      };

      return {
        ...row,
        turnoverPerHour:
          row.turnover != null && row.hours > 0 ? row.turnover / row.hours : null,
      };
    });

    const totalHours = orderedRows.reduce((sum, row) => sum + row.hours, 0);
    const totalTurnover = orderedRows.reduce(
      (sum, row) => sum + Number(row.turnover ?? 0),
      0,
    );

    const averageRow: CustomerMonthlyEconomicsRow = {
      monthKey: "average",
      monthLabel: "",
      turnover: totalTurnover,
      turnoverFromTotal: false,
      hours: totalHours,
      turnoverPerHour:
        totalTurnover != null && totalHours > 0
          ? totalTurnover / totalHours
          : null,
    };

    setCustomerMonthlyEconomicsRows([...orderedRows, averageRow]);
  }, [
    monthlyHourGroupRows,
    monthlyInvoiceGroupRows,
    rollingWindow,
    selectedCustomerId,
    selectedMonthlyArticleGroupSet,
    t,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchArticleGroups() {
      if (!selectedCustomerId && !selectedManagerId) {
        setArticleGroupRows([]);
        setArticleGroupsLoading(false);
        return;
      }

      const scopedCustomers = filteredCustomers;
      if (scopedCustomers.length === 0) {
        setArticleGroupRows([]);
        setArticleGroupsLoading(false);
        return;
      }

      setArticleGroupsLoading(true);
      const supabase = createClient();

      const customerIds = scopedCustomers.map((customer) => customer.id);
      const customerIdChunks = chunkArray(customerIds, 200);
      const customerNumbers = Array.from(
        new Set(
          scopedCustomers
            .map((customer) => customer.fortnox_customer_number)
            .filter(
              (value): value is string =>
                Boolean(value && value.trim().length > 0),
            ),
        ),
      );
      const customerNumberChunks = chunkArray(customerNumbers, 200);

      const invoiceNumbersSet = new Set<string>();
      const seenInvoiceIds = new Set<string>();

      for (const idChunk of customerIdChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{ id: string; document_number: string | null }>(() =>
          supabase
            .from("invoices")
            .select("id, document_number")
            .in("customer_id", idChunk)
            .gte("invoice_date", rollingWindow.from)
            .lte("invoice_date", rollingWindow.to),
        );

        for (const row of rows) {
          seenInvoiceIds.add(row.id);
          const documentNumber = row.document_number?.trim();
          if (!documentNumber) continue;
          invoiceNumbersSet.add(documentNumber);
        }
      }

      for (const numberChunk of customerNumberChunks) {
        if (cancelled) return;

        const rows = await fetchAllPages<{ id: string; document_number: string | null }>(() =>
          supabase
            .from("invoices")
            .select("id, document_number")
            .in("fortnox_customer_number", numberChunk)
            .gte("invoice_date", rollingWindow.from)
            .lte("invoice_date", rollingWindow.to),
        );

        for (const row of rows) {
          if (seenInvoiceIds.has(row.id)) continue;
          seenInvoiceIds.add(row.id);

          const documentNumber = row.document_number?.trim();
          if (!documentNumber) continue;
          invoiceNumbersSet.add(documentNumber);
        }
      }

      const invoiceNumbers = Array.from(invoiceNumbersSet);

      if (invoiceNumbers.length === 0) {
        setArticleGroupRows([]);
        setArticleGroupsLoading(false);
        return;
      }

      const { data: mappingsData } = await supabase
        .from("article_group_mappings")
        .select("article_number, group_name, article_name, active");

      if (cancelled) return;

      const mappingByArticleNumber = new Map<
        string,
        { groupName: string; articleName: string | null }
      >();
      for (const row of (mappingsData ?? []) as Array<{
        article_number: string | null;
        group_name: string | null;
        article_name: string | null;
        active: boolean | null;
      }>) {
        if (row.active === false) continue;
        const articleNumber = row.article_number?.trim();
        const groupName = row.group_name?.trim();
        if (!articleNumber || !groupName) continue;
        mappingByArticleNumber.set(articleNumber, {
          groupName,
          articleName: row.article_name?.trim() || null,
        });
      }

      const invoiceNumberChunks = chunkArray(invoiceNumbers, 200);

      const groupMap = new Map<
        string,
        {
          turnoverExVat: number;
          rowCount: number;
          quantity: number;
          articles: Map<
            string,
            {
              articleNumber: string | null;
              articleName: string;
              turnoverExVat: number;
              rowCount: number;
              quantity: number;
              invoiceNumbers: Set<string>;
            }
          >;
        }
      >();

      let totalTurnoverExVat = 0;

      for (const chunk of invoiceNumberChunks) {
        if (cancelled) return;

        const invoiceRows = await fetchAllPages<{
          invoice_number: string | null;
          article_number: string | null;
          article_name: string | null;
          quantity: number | null;
          total_ex_vat: number | null;
          total: number | null;
        }>(() =>
          supabase
            .from("invoice_rows")
            .select("invoice_number, article_number, article_name, quantity, total_ex_vat, total")
            .in("invoice_number", chunk),
        );

        for (const row of invoiceRows) {
          const invoiceNumber = row.invoice_number?.trim() ?? null;
          const articleNumber = row.article_number?.trim() || null;
          const mapping = articleNumber
            ? mappingByArticleNumber.get(articleNumber)
            : null;
          const articleName =
            mapping?.articleName ||
            row.article_name?.trim() ||
            t("reports.unknown", "Unknown");
          const groupName = (mapping?.groupName ?? null) ??
            t("reports.articleGroups.unmapped", "Unmapped");
          const turnoverExVat = Number(row.total_ex_vat ?? 0);
          const quantity = Number(row.quantity ?? 0);

          totalTurnoverExVat += turnoverExVat;

          const currentGroup =
            groupMap.get(groupName) ??
            {
              turnoverExVat: 0,
              rowCount: 0,
              quantity: 0,
              articles: new Map(),
            };

          currentGroup.turnoverExVat += turnoverExVat;
          currentGroup.rowCount += 1;
          currentGroup.quantity += quantity;

          const articleKey = articleNumber ?? `name:${articleName}`;
          const currentArticle =
            currentGroup.articles.get(articleKey) ??
            {
              articleNumber,
              articleName,
              turnoverExVat: 0,
              rowCount: 0,
              quantity: 0,
              invoiceNumbers: new Set<string>(),
            };

          currentArticle.turnoverExVat += turnoverExVat;
          currentArticle.rowCount += 1;
          currentArticle.quantity += quantity;
          if (invoiceNumber) {
            currentArticle.invoiceNumbers.add(invoiceNumber);
          }

          currentGroup.articles.set(articleKey, currentArticle);
          groupMap.set(groupName, currentGroup);
        }
      }

      const rows: ArticleGroupSummaryRow[] = Array.from(groupMap.entries())
        .map(([groupName, group]) => {
          const articles = Array.from(group.articles.values())
            .map((article) => ({
              articleNumber: article.articleNumber,
              articleName: article.articleName,
              turnoverExVat: article.turnoverExVat,
              rowCount: article.rowCount,
              quantity: article.quantity,
              invoiceNumbers: Array.from(article.invoiceNumbers.values()).sort(
                (a, b) => a.localeCompare(b),
              ),
              shareOfGroup:
                group.turnoverExVat > 0
                  ? (article.turnoverExVat / group.turnoverExVat) * 100
                  : 0,
            }))
            .sort((a, b) => b.turnoverExVat - a.turnoverExVat);

          return {
            groupName,
            turnoverExVat: group.turnoverExVat,
            articleCount: articles.length,
            rowCount: group.rowCount,
            quantity: group.quantity,
            shareOfTotal:
              totalTurnoverExVat > 0
                ? (group.turnoverExVat / totalTurnoverExVat) * 100
                : 0,
            articles,
          };
        })
        .sort((a, b) => b.turnoverExVat - a.turnoverExVat);

      setArticleGroupRows(rows);
      // Reset to all-collapsed when the rows change, but keep any user-toggled
      // open state across re-renders within the same row set.
      setOpenArticleGroups((current) => {
        if (rows.length === 0) return {};
        return current;
      });
      setArticleGroupsLoading(false);
    }

    fetchArticleGroups().catch(() => {
      if (!cancelled) {
        setArticleGroupRows([]);
        setArticleGroupsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    filteredCustomers,
    rollingWindow,
    selectedCustomerId,
    selectedManagerId,
    t,
  ]);

  const monthlyTimeReportingColumns: ColumnDef<
    MonthlyTimeReportingRow,
    unknown
  >[] = [
    {
      id: "monthLabel",
      accessorFn: (row) => row.monthKey,
      header: t("reports.columns.month", "Month"),
      size: 160,
      enableSorting: true,
      sortingFn: (rowA, rowB) =>
        compareMonthKeys(rowA.original.monthKey, rowB.original.monthKey),
      cell: ({ row }) => row.original.monthLabel,
    },
    {
      id: "customerHours",
      accessorKey: "customerHours",
      header: t("reports.columns.customerHours", "Customer Hours"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderHourCell(row.original.customerHours, () =>
          openMonthlyTimeDetails(row.original, "customerHours"),
        ),
    },
  ];

  if (selectedManagerId) {
    monthlyTimeReportingColumns.push(
      {
        id: "absenceHours",
        accessorKey: "absenceHours",
        header: t("reports.columns.absence", "Absence"),
        size: 140,
        enableSorting: false,
        cell: ({ row }) =>
          renderHourCell(row.original.absenceHours, () =>
            openMonthlyTimeDetails(row.original, "absenceHours"),
          ),
      },
      {
        id: "internalHours",
        accessorKey: "internalHours",
        header: t("reports.columns.internal", "Internal"),
        size: 140,
        enableSorting: false,
        cell: ({ row }) =>
          renderHourCell(row.original.internalHours, () =>
            openMonthlyTimeDetails(row.original, "internalHours"),
          ),
      },
      {
        id: "totalHours",
        accessorKey: "totalHours",
        header: t("reports.columns.total", "Total"),
        size: 140,
        enableSorting: false,
        cell: ({ row }) =>
          renderHourCell(row.original.totalHours, () =>
            openMonthlyTimeDetails(row.original, "totalHours"),
          ),
      },
    );
  }

  const customerTimeReportingColumns: ColumnDef<
    CustomerTimeReportingRow,
    unknown
  >[] = [
    {
      id: "contributorName",
      accessorKey: "contributorName",
      header: t("reports.columns.customerManager", "Customer Manager"),
      size: 220,
      enableSorting: false,
    },
    {
      id: "groupName",
      accessorKey: "groupName",
      header: t("reports.columns.group", "Group"),
      size: 180,
      enableSorting: false,
    },
    {
      id: "customerHours",
      accessorKey: "customerHours",
      header: t("reports.columns.customerHours", "Customer Hours"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderHourCell(row.original.customerHours, () =>
          openCustomerTimeDetails(row.original, "customerHours"),
        ),
    },
    {
      id: "workloadPercentage",
      accessorKey: "workloadPercentage",
      header: t("reports.columns.workloadShare", "Workload Share"),
      size: 200,
      minSize: 200,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => renderWorkloadShareCell(row.original.workloadPercentage),
    },
  ];

  const otherManagersTimeReportingColumns: ColumnDef<
    CustomerTimeReportingRow,
    unknown
  >[] = [
    {
      id: "contributorName",
      accessorKey: "contributorName",
      header: t("reports.columns.customerManager", "Customer Manager"),
      size: 220,
      enableSorting: false,
    },
    {
      id: "groupName",
      accessorKey: "groupName",
      header: t("reports.columns.group", "Group"),
      size: 180,
      enableSorting: false,
    },
    {
      id: "customerHours",
      accessorKey: "customerHours",
      header: t("reports.columns.customerHours", "Customer Hours"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderHourCell(row.original.customerHours, () =>
          openOtherManagersTimeDetails(row.original, "customerHours"),
        ),
    },
    {
      id: "workloadPercentage",
      accessorKey: "workloadPercentage",
      header: t("reports.columns.workloadShare", "Workload Share"),
      size: 200,
      minSize: 200,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => renderWorkloadShareCell(row.original.workloadPercentage),
    },
  ];

  const managerCustomerSummaryColumns: ColumnDef<
    ManagerCustomerSummaryRow,
    unknown
  >[] = [
    {
      id: "customerName",
      accessorKey: "customerName",
      header: t("reports.columns.customerName", "Customer name"),
      size: 260,
      enableSorting: false,
    },
    {
      id: "turnover",
      accessorKey: "turnover",
      header: t("reports.columns.turnover", "Turnover"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderTurnoverCell(row.original.turnover, () =>
          openManagerCustomerInvoiceDetails(row.original),
        ),
    },
    {
      id: "invoiceCount",
      accessorKey: "invoiceCount",
      header: t("reports.columns.invoices", "Invoices"),
      size: 140,
      enableSorting: false,
      cell: ({ row }) => row.original.invoiceCount.toLocaleString("sv-SE"),
    },
    {
      id: "contractValue",
      accessorKey: "contractValue",
      header: t("reports.columns.contractValue", "Contract value"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderTurnoverCell(row.original.contractValue, () =>
          openManagerCustomerContractDetails(row.original),
        ),
    },
    {
      id: "customerHours",
      accessorKey: "customerHours",
      header: t("reports.columns.hours", "Hours"),
      size: 140,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.customerHours.toLocaleString("sv-SE", {
          maximumFractionDigits: 1,
        }),
    },
    {
      id: "turnoverPerHour",
      header: t("reports.columns.turnoverPerHours", "Turnover / Hours"),
      size: 200,
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.turnover == null) {
          return t("reports.missing", "missing");
        }
        if (row.original.customerHours <= 0) {
          return "-";
        }
        return `${sekFormatter.format(
          row.original.turnover / row.original.customerHours,
        )} / h`;
      },
    },
    {
      id: "workloadPercentage",
      accessorKey: "workloadPercentage",
      header: t("reports.columns.workload", "Workload"),
      size: 200,
      minSize: 200,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => renderWorkloadShareCell(row.original.workloadPercentage),
    },
  ];

  const helpedCustomerManagersColumns: ColumnDef<
    HelpedCustomerManagerRow,
    unknown
  >[] = [
    {
      id: "managerName",
      accessorKey: "managerName",
      header: t("reports.columns.customerManager", "Customer manager"),
      size: 240,
      enableSorting: false,
    },
    {
      id: "groupName",
      accessorKey: "groupName",
      header: t("reports.columns.group", "Group"),
      size: 180,
      enableSorting: false,
    },
    {
      id: "customerHours",
      accessorKey: "customerHours",
      header: t("reports.columns.customerHours", "Customer Hours"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderHourCell(row.original.customerHours, () =>
          openHelpedCustomerManagersDetails(row.original, "customerHours"),
        ),
    },
    {
      id: "workloadPercentage",
      accessorKey: "workloadPercentage",
      header: t("reports.columns.workload", "Workload"),
      size: 200,
      minSize: 200,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => renderWorkloadShareCell(row.original.workloadPercentage),
    },
  ];

  const customerMonthlyEconomicsColumns: ColumnDef<
    CustomerMonthlyEconomicsRow,
    unknown
  >[] = [
    {
      id: "monthLabel",
      accessorFn: (row) => row.monthKey,
      header: t("reports.columns.month", "Month"),
      size: 180,
      enableSorting: true,
      sortingFn: (rowA, rowB) =>
        compareMonthKeysWithAverageFixed(rowA.original, rowB.original),
      cell: ({ row }) => row.original.monthLabel,
    },
    {
      id: "turnover",
      accessorKey: "turnover",
      header: t("reports.columns.turnover", "Turnover"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderTurnoverCell(
          row.original.turnover,
          row.original.monthKey !== "average"
            ? () => openMonthlyInvoiceDetails(row.original)
            : undefined,
          row.original.turnoverFromTotal,
        ),
    },
    {
      id: "hours",
      accessorKey: "hours",
      header: t("reports.columns.hours", "Hours"),
      size: 140,
      enableSorting: false,
      cell: ({ row }) =>
        renderHourCell(
          row.original.hours,
          row.original.monthKey !== "average"
            ? () =>
                openMonthlyTimeDetails(
                  {
                    monthKey: row.original.monthKey,
                    monthLabel: row.original.monthLabel,
                    customerHours: row.original.hours,
                    absenceHours: 0,
                    internalHours: 0,
                    totalHours: row.original.hours,
                  },
                  "customerHours",
                )
            : undefined,
        ),
    },
    {
      id: "turnoverPerHour",
      accessorKey: "turnoverPerHour",
      header: t("reports.columns.turnoverPerHours", "Turnover / Hours"),
      size: 220,
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.turnover == null) {
          return t("reports.missing", "missing");
        }
        if (row.original.hours <= 0) {
          return "-";
        }
        const turnoverPerHour =
          row.original.turnoverPerHour ?? row.original.turnover / row.original.hours;
        return `${sekFormatter.format(turnoverPerHour)} / h`;
      },
    },
  ];

  const customerAccrualColumns: ColumnDef<ContractAccrual, unknown>[] = [
    {
      id: "contract_number",
      accessorKey: "contract_number",
      header: t("reports.columns.contract", "Contract"),
      size: 140,
      enableSorting: false,
    },
    {
      id: "description",
      accessorKey: "description",
      header: t("reports.columns.description", "Description"),
      size: 220,
      enableSorting: false,
      cell: ({ row }) => row.original.description ?? "-",
    },
    {
      id: "period",
      accessorKey: "period",
      header: t("reports.columns.period", "Period"),
      size: 100,
      enableSorting: false,
      cell: ({ row }) => row.original.period ?? "-",
    },
    {
      id: "start_date",
      accessorKey: "start_date",
      header: t("reports.columns.start", "Start"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => row.original.start_date ?? "-",
    },
    {
      id: "end_date",
      accessorKey: "end_date",
      header: t("reports.columns.end", "End"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => row.original.end_date ?? "-",
    },
    {
      id: "total",
      accessorKey: "total",
      header: t("reports.columns.total", "Total"),
      size: 140,
      enableSorting: false,
      cell: ({ row }) =>
        sekFormatter.format(
                  Number(row.original.total_ex_vat ?? 0),
        ),
    },
    {
      id: "annualized",
      header: t("reports.columns.annualized", "Annualized"),
      size: 160,
      enableSorting: false,
      cell: ({ row }) =>
        sekFormatter.format(
                  annualizeContractTotal(
                    row.original.total_ex_vat,
                    row.original.period,
                  ),
        ),
    },
    {
      id: "is_active",
      accessorKey: "is_active",
      header: t("reports.columns.status", "Status"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => (row.original.is_active ? "Active" : "Inactive"),
    },
  ];

  const timeDetailsColumns: ColumnDef<TimeDetailRow, unknown>[] = [
    {
      id: "reportDate",
      accessorKey: "reportDate",
      header: t("reports.columns.date", "Date"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => row.original.reportDate ?? "-",
    },
    {
      id: "customerName",
      accessorKey: "customerName",
      header: t("reports.columns.customer", "Customer"),
      size: 220,
      enableSorting: false,
      cell: ({ row }) => row.original.customerName ?? "-",
    },
    {
      id: "employeeName",
      accessorKey: "employeeName",
      header: t("reports.columns.costCenter", "Cost center"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) => row.original.employeeName ?? "-",
    },
    {
      id: "entryType",
      accessorKey: "entryType",
      header: t("reports.columns.type", "Type"),
      size: 140,
      enableSorting: false,
      cell: ({ row }) => row.original.entryType ?? "-",
    },
    {
      id: "hours",
      accessorKey: "hours",
      header: t("reports.columns.hours", "Hours"),
      size: 110,
      enableSorting: false,
      cell: ({ row }) => hoursFormatter.format(row.original.hours),
    },
    {
      id: "projectName",
      accessorKey: "projectName",
      header: t("reports.columns.project", "Project"),
      size: 200,
      enableSorting: false,
      cell: ({ row }) => row.original.projectName ?? "-",
    },
    {
      id: "activity",
      accessorKey: "activity",
      header: t("reports.columns.activity", "Activity"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) => row.original.activity ?? "-",
    },
    {
      id: "description",
      accessorKey: "description",
      header: t("reports.columns.description", "Description"),
      size: 260,
      enableSorting: false,
      cell: ({ row }) => row.original.description ?? "-",
    },
  ];

  const invoiceDetailsColumns: ColumnDef<InvoiceDetailRow, unknown>[] = [
    {
      id: "documentNumber",
      accessorKey: "documentNumber",
      header: t("reports.columns.invoiceNumber", "Invoice #"),
      size: 160,
      enableSorting: false,
    },
    {
      id: "customerName",
      accessorKey: "customerName",
      header: t("reports.columns.customer", "Customer"),
      size: 220,
      enableSorting: false,
      cell: ({ row }) => row.original.customerName ?? "-",
    },
    {
      id: "invoiceDate",
      accessorKey: "invoiceDate",
      header: t("reports.columns.date", "Date"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => row.original.invoiceDate ?? "-",
    },
    {
      id: "dueDate",
      accessorKey: "dueDate",
      header: t("reports.columns.dueDate", "Due date"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => row.original.dueDate ?? "-",
    },
    {
      id: "turnover",
      accessorKey: "turnover",
      header: t("reports.columns.turnover", "Turnover"),
      size: 180,
      enableSorting: false,
      cell: ({ row }) =>
        renderTurnoverCell(
          row.original.turnover,
          undefined,
          row.original.turnoverFromTotal,
        ),
    },
    {
      id: "status",
      accessorKey: "status",
      header: t("reports.columns.status", "Status"),
      size: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const status = row.original.status;
        if (!status) return "-";
        return (
          <Badge variant={status === "paid" ? "secondary" : "outline"}>
            {status === "paid"
              ? t("reports.invoiceStatus.paid", "Paid")
              : t("reports.invoiceStatus.pending", "Pending")}
          </Badge>
        );
      },
    },
  ];

  function renderArticleGroupsSection() {
    return (
      <section className="space-y-3">
        <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
          <h3 className="text-base font-semibold">
            {t("reports.sections.articleGroups.title", "Article groups")} ({articleGroupRows.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(
              "reports.sections.articleGroups.description",
              "Mapped follow-up per article group for current selection.",
            )}
          </p>
        </div>

        {articleGroupsLoading ? (
          <Skeleton className="h-[280px] w-full" />
        ) : articleGroupRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "reports.empty.noArticleGroups",
              "No article group rows found for this customer in the selected range.",
            )}
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table className="table-auto">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("reports.articleGroups.group", "Group")}</TableHead>
                  <TableHead>{t("reports.articleGroups.turnoverExVat", "Turnover")}</TableHead>
                  <TableHead>{t("reports.articleGroups.articles", "Articles")}</TableHead>
                  <TableHead>{t("reports.articleGroups.count", "Count")}</TableHead>
                  <TableHead>{t("reports.articleGroups.quantity", "Quantity")}</TableHead>
                  <TableHead className="w-[200px] min-w-[200px] max-w-[200px]">{t("reports.articleGroups.share", "Share")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {articleGroupRows.map((group) => {
                  const isOpen = openArticleGroups[group.groupName] ?? false;
                  return (
                    <React.Fragment key={group.groupName}>
                      <TableRow>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-1"
                            onClick={() =>
                              setOpenArticleGroups((current) => ({
                                ...current,
                                [group.groupName]: !isOpen,
                              }))
                            }
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                            <span className="font-medium">{group.groupName}</span>
                          </Button>
                        </TableCell>
                        <TableCell className="font-medium">
                          {sekFormatter.format(group.turnoverExVat)}
                        </TableCell>
                        <TableCell>{group.articleCount}</TableCell>
                        <TableCell>{group.rowCount}</TableCell>
                        <TableCell>{hoursFormatter.format(group.quantity)}</TableCell>
                        <TableCell className="w-[200px] min-w-[200px] max-w-[200px]">{renderWorkloadShareCell(group.shareOfTotal)}</TableCell>
                      </TableRow>

                      {isOpen
                        ? group.articles.map((article) => (
                            <TableRow
                              key={`${group.groupName}:${article.articleNumber ?? article.articleName}`}
                              className="bg-muted/20 hover:bg-muted/30"
                            >
                              {/*
                                Outer headers: Group | Turnover | Articles | Count | Quantity | Share (6).
                                We render 6 cells per article so Turnover/Count/Quantity/Share line up
                                under their headers exactly. The "Articles" slot has no per-article
                                meaning so it stays empty (the parent group row already shows the count).
                                Article # is stacked above Name in the first cell.
                              */}
                              <TableCell className="pl-8">
                                <div className="flex flex-col">
                                  <span className="text-xs text-muted-foreground">
                                    {article.articleNumber ?? "—"}
                                  </span>
                                  <span>{article.articleName}</span>
                                </div>
                              </TableCell>
                              <TableCell className="font-medium">
                                {renderTurnoverCell(
                                  article.turnoverExVat,
                                  article.turnoverExVat !== 0
                                    ? () =>
                                        openArticleItemInvoiceDetails(
                                          group.groupName,
                                          article,
                                        )
                                    : undefined,
                                )}
                                {article.turnoverExVat === 0 &&
                                article.invoiceNumbers.length > 0 ? (
                                  <p className="mt-1 text-xs font-normal text-muted-foreground">
                                    {t("reports.articleGroups.derivedFrom", "Derived from")}: {article.invoiceNumbers[0]}
                                    {article.invoiceNumbers.length > 1
                                      ? ` (+${article.invoiceNumbers.length - 1})`
                                      : ""}
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell aria-hidden="true" />
                              <TableCell>{article.rowCount}</TableCell>
                              <TableCell>
                                {hoursFormatter.format(article.quantity)}
                              </TableCell>
                              <TableCell className="w-[200px] min-w-[200px] max-w-[200px]">
                                <span className="text-muted-foreground">
                                  {Math.round(article.shareOfGroup)}%
                                </span>
                              </TableCell>
                            </TableRow>
                          ))
                        : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className={cn("grid gap-4 lg:flex-1", filterGridClass)}>
          {showTeamFilter ? (
            <SearchSelect
              placeholder={t("reports.filters.allTeams", "All teams")}
              searchPlaceholder={t("reports.filters.searchTeams", "Search teams...")}
              options={teamOptions}
              value={selectedTeamId}
              onChange={(value) => {
                setSelectedTeamId(value);
                setSelectedManagerId(null);
                setSelectedCustomerId(null);
              }}
              disabled={teamFilterDisabled}
              allLabel={t("reports.filters.allTeams", "All teams")}
              noOptionsLabel={t("reports.filters.noOptions", "No options found.")}
            />
          ) : null}

          <SearchSelect
            placeholder={managerAllLabel}
            searchPlaceholder={t(
              "reports.filters.searchCustomerManagers",
              "Search customer managers...",
            )}
            options={managerOptions}
            value={selectedManagerId}
            onChange={(value) => {
              setSelectedManagerId(value);
              setSelectedCustomerId(null);
            }}
            disabled={loading || managerOptions.length === 0 || user.role === "user"}
            allLabel={managerAllLabel}
            noOptionsLabel={t("reports.filters.noOptions", "No options found.")}
          />

          <SearchSelect
            placeholder={customerAllLabel}
            searchPlaceholder={t("reports.filters.searchCustomers", "Search customers...")}
            options={customerOptions}
            value={selectedCustomerId}
            onChange={setSelectedCustomerId}
            disabled={loading || customerOptions.length === 0}
            allLabel={customerAllLabel}
            noOptionsLabel={t("reports.filters.noOptions", "No options found.")}
          />

          {showMonthPicker ? (
            <SearchSelect
              placeholder={t("reports.filters.selectMonth", "Select month")}
              searchPlaceholder={t("reports.filters.searchMonth", "Search month...")}
              options={monthOptions}
              value={selectedMonth}
              onChange={(value) =>
                setSelectedMonth(value ?? toMonthKey(new Date()))
              }
              allowClear={false}
              noOptionsLabel={t("reports.filters.noOptions", "No options found.")}
            />
          ) : null}

          <SearchSelect
            placeholder={t("reports.filters.selectPeriod", "Select period")}
            searchPlaceholder={t("reports.filters.searchPeriod", "Search period...")}
            options={reportingWindowOptions}
            value={selectedWindowMode}
            onChange={(value) =>
              setSelectedWindowMode(
                (value as ReportingWindowMode | null) ?? "rolling-12-months",
              )
            }
            allowClear={false}
            noOptionsLabel={t("reports.filters.noOptions", "No options found.")}
          />
        </div>

        <div className="flex items-center gap-2 lg:shrink-0">
          <Button variant="outline" className="h-9 self-center" onClick={handleResetFilters}>
            {t("reports.filters.reset", "Reset filters")}
          </Button>
          <div className="inline-flex h-10 items-center px-1 text-sm font-medium text-muted-foreground">
            <span className="text-[#d4af37]">{filteredCustomers.length}</span>
            <span>
              &nbsp;
              {filteredCustomers.length === 1
                ? t("reports.filters.customerSingular", "customer")
                : t("reports.filters.customerPlural", "customers")}{" "}
              {t("reports.filters.inCurrentFilter", "in current filter")}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-10">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>

          <section className="space-y-3">
            <div className="space-y-2 border-t border-[#8b6f2a] pt-6">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <Skeleton className="h-[280px] w-full" />
          </section>

          <section className="space-y-3">
            <div className="space-y-2 border-t border-[#8b6f2a] pt-6">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-[420px] w-full" />
          </section>
        </div>
      ) : filteredCustomers.length === 0 ? (
        <EmptyState
          icon={Filter}
          title={t("reports.empty.noCustomers.title", "No customers match this filter")}
          description={t(
            "reports.empty.noCustomers.description",
            "Adjust team, customer manager, or customer selection to view KPIs.",
          )}
        />
      ) : (
        <div className="space-y-10">
          <div className="space-y-2">
              <KpiCards
                values={kpis}
                previousValues={previousKpis}
                comparisonContractValue={currentContractValueSnapshot}
                onOpenInvoices={() => {
                  void openInvoicesStatusDialog();
                }}
                compact
                hoursMode={selectedCustomerId ? "turnoverPerHour" : "hours"}
                turnoverPerHour={
                  kpis.hours > 0 ? kpis.turnover / kpis.hours : 0
                }
                previousTurnoverPerHour={
                  previousKpis && previousKpis.hours > 0
                    ? previousKpis.turnover / previousKpis.hours
                    : undefined
                }
              />
            {kpiLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("reports.kpis.updating", "Updating KPIs...")}
              </p>
            ) : null}
          </div>

          <section className="space-y-3">
            <div className="flex items-start justify-between gap-3 border-t border-[#8b6f2a] pt-6">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">
                  {t("reports.sections.turnoverPerMonth.title", "Turnover per month")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "reports.sections.turnoverPerMonth.description",
                    "Based on current filters and rolling 12-month window.",
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Select
                  value={comparisonMode}
                  onValueChange={(value) =>
                    setComparisonMode(value as ComparisonMode)
                  }
                >
                  <SelectTrigger className="h-7 w-auto min-w-[180px] text-xs" data-size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="year-over-year">
                      {t(
                        "reports.comparison.yearOverYear",
                        "Same period last year",
                      )}
                    </SelectItem>
                    <SelectItem value="period-over-period">
                      {t("reports.comparison.periodOverPeriod", "Previous period")}
                    </SelectItem>
                    <SelectItem value="none">
                      {t("reports.comparison.none", "None")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div className="inline-flex rounded-md border border-border bg-background p-1">
                  <Button
                    type="button"
                    variant={turnoverChartMode === "bar" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => setTurnoverChartMode("bar")}
                    aria-label={t("reports.chart.mode.bar", "Bar")}
                    title={t("reports.chart.mode.bar", "Bar")}
                  >
                    <BarChart3 className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant={turnoverChartMode === "line" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => setTurnoverChartMode("line")}
                    aria-label={t("reports.chart.mode.line", "Line")}
                    title={t("reports.chart.mode.line", "Line")}
                  >
                    <TrendingUp className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            {kpiLoading ? (
              <Skeleton className="h-[280px] w-full" />
            ) : (
              <ChartContainer
                config={turnoverChartConfig}
                className="h-[280px]"
              >
                {turnoverChartMode === "bar" ? (
                  <BarChart
                    accessibilityLayer
                    data={turnoverChartData}
                    margin={{
                      top: 20,
                      bottom: 12,
                    }}
                  >
                    <CartesianGrid className="stroke-muted-foreground/20" />
                    <XAxis
                      dataKey="month"
                      tickLine={false}
                      tickMargin={10}
                      axisLine={false}
                    />
                    <YAxis
                      hide
                      tickCount={6}
                      domain={[
                        0,
                        (dataMax: number) => getRoundedChartMax(dataMax),
                      ]}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <TurnoverTooltipContent
                          turnoverLabel={t("reports.columns.turnover", "Turnover")}
                          invoicesLabel={t("reports.columns.invoices", "Invoices")}
                          previousLabel={t(
                            "reports.columns.previousPeriod",
                            "Previous period",
                          )}
                        />
                      }
                    />
                    <Bar
                      dataKey="turnover"
                      fill="var(--color-turnover)"
                      barSize={16}
                      radius={0}
                    >
                      <LabelList
                        dataKey="turnover"
                        position="top"
                        offset={10}
                        className="fill-foreground"
                        fontSize={11}
                        formatter={(value) => {
                          const numericValue = Number(value ?? 0);
                          return numericValue === 0
                            ? ""
                            : sekFormatter.format(numericValue);
                        }}
                      />
                    </Bar>
                    {previousTurnoverByMonthRows ? (
                      <Bar
                        dataKey="previousTurnover"
                        fill="var(--color-turnoverPrevious)"
                        barSize={16}
                        radius={0}
                      />
                    ) : null}
                  </BarChart>
                ) : (
                  <LineChart
                    accessibilityLayer
                    data={turnoverChartData}
                    margin={{
                      top: 20,
                      bottom: 12,
                    }}
                  >
                    <defs>
                      <linearGradient id={turnoverGradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-turnover)" stopOpacity={0.8} />
                        <stop offset="100%" stopColor="var(--color-turnover)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid className="stroke-muted-foreground/20" />
                    <XAxis
                      dataKey="month"
                      tickLine={false}
                      tickMargin={10}
                      axisLine={false}
                      padding={{ left: 20, right: 20 }}
                    />
                    <YAxis
                      hide
                      tickCount={6}
                      domain={[
                        0,
                        (dataMax: number) => getRoundedChartMax(dataMax),
                      ]}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <TurnoverTooltipContent
                          turnoverLabel={t("reports.columns.turnover", "Turnover")}
                          invoicesLabel={t("reports.columns.invoices", "Invoices")}
                          previousLabel={t(
                            "reports.columns.previousPeriod",
                            "Previous period",
                          )}
                        />
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="turnover"
                      fill={`url(#${turnoverGradientId})`}
                      fillOpacity={1}
                      baseValue={0}
                      stroke="none"
                    />
                    <Line
                      type="monotone"
                      dataKey="turnover"
                      stroke="var(--color-turnover)"
                      strokeWidth={2.25}
                      dot={{ r: 3, fill: "var(--color-turnover)", strokeWidth: 0 }}
                      activeDot={{ r: 4 }}
                    >
                      <LabelList
                        dataKey="turnover"
                        position="top"
                        offset={10}
                        className="fill-foreground"
                        fontSize={11}
                        formatter={(value) => {
                          const numericValue = Number(value ?? 0);
                          return numericValue === 0
                            ? ""
                            : sekFormatter.format(numericValue);
                        }}
                      />
                    </Line>
                    {previousTurnoverByMonthRows ? (
                      <Line
                        type="monotone"
                        dataKey="previousTurnover"
                        stroke="var(--color-turnoverPrevious)"
                        strokeWidth={2}
                        dot={{ r: 3, fill: "var(--color-turnoverPrevious)", strokeWidth: 0 }}
                        activeDot={{ r: 4 }}
                      />
                    ) : null}
                  </LineChart>
                )}
              </ChartContainer>
            )}
          </section>

          {selectedManagerId && !selectedCustomerId ? (
            <section className="space-y-3">
              <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
                <h3 className="text-base font-semibold">
                  {t("reports.sections.customersInCostCenter.title", "Customers in cost center")}{" "}
                  {selectedManager?.fortnox_cost_center ?? "-"} -{" "}
                  {selectedManager?.full_name ?? t("reports.selectedCustomerManager", "Selected customer manager")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "reports.sections.customersInCostCenter.description",
                    "Period summary for customers in the selected customer manager scope.",
                  )}
                </p>
              </div>

              <DataTable
                columns={managerCustomerSummaryColumns}
                data={managerCustomerSummaryRows}
                loading={managerCustomerSummaryLoading}
                hideRowCount
                pageSize={12}
                fixedColumnWidths={{ workloadPercentage: 200, _navigate: 60 }}
                onRowNavigate={(row) => {
                  setSelectedCustomerId(row.customerId);
                  scrollReportsViewportToTop();
                }}
                emptyState={{
                  icon: Filter,
                  title: t("reports.empty.noCustomerSummaryRows.title", "No customer summary rows"),
                  description: t(
                    "reports.empty.noCustomerSummaryRows.description",
                    "No customer KPI rows were found for this manager and period.",
                  ),
                }}
              />
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
              <h3 className="text-base font-semibold">
                {t("reports.sections.timeReporting.title", "Time reporting")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {selectedWindowMode === "current-month"
                  ? t(
                      "reports.sections.timeReporting.currentMonthDescription",
                      "Current month view based on selected month.",
                    )
                  : selectedWindowMode === "rolling-year"
                    ? t(
                        "reports.sections.timeReporting.rollingYearDescription",
                        "Calendar year view based on selected month year.",
                      )
                    : t(
                        "reports.sections.timeReporting.rolling12MonthsDescription",
                        "Rolling 12-month view based on selected month.",
                      )}
              </p>
            </div>
            {!selectedCustomerId ? (
              <DataTable
                columns={monthlyTimeReportingColumns}
                data={monthlyTimeReportingRows}
                loading={monthlyTimeReportingLoading}
                hideRowCount
                pageSize={12}
                sortingStorageKey="reports.monthly-time-reporting.sort"
                emptyState={{
                  icon: Filter,
                  title: t("reports.empty.noTimeReportingData.title", "No time reporting data"),
                  description: t(
                    "reports.empty.noTimeReportingData.description",
                    "No time reporting data found for this scope.",
                  ),
                }}
              />
            ) : (
              <DataTable
                columns={customerTimeReportingColumns}
                data={customerTimeReportingRows}
                loading={customerTimeReportingLoading}
                hideRowCount
                pageSize={12}
                fixedColumnWidths={{ workloadPercentage: 200 }}
                emptyState={{
                  icon: Filter,
                  title: t("reports.empty.noCustomerHourEntries.title", "No customer-hour entries"),
                  description: t(
                    "reports.empty.noCustomerHourEntries.description",
                    "No customer-hour entries found for this customer in the selected rolling window.",
                  ),
                }}
              />
            )}

            {selectedManagerId && !selectedCustomerId ? (
              <div className="mt-8 space-y-3">
                <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
                  <h4 className="text-sm font-semibold">
                    {t(
                      "reports.sections.otherManagersOnSelected.title",
                      "Help received from other customer managers",
                    )}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "reports.sections.otherManagersOnSelected.description",
                      "Hours other customer managers logged on customers in this manager's portfolio.",
                    )}
                  </p>
                </div>

                <DataTable
                  columns={otherManagersTimeReportingColumns}
                  data={otherManagersTimeReportingRows}
                  loading={otherManagersTimeReportingLoading}
                  hideRowCount
                  pageSize={12}
                  fixedColumnWidths={{ workloadPercentage: 200 }}
                  emptyState={{
                    icon: Filter,
                    title: t("reports.empty.noOtherManagerReports.title", "No other manager reports"),
                    description: t(
                      "reports.empty.noOtherManagerReports.description",
                      "No customer-hour entries from other customer managers were found for this scope.",
                    ),
                  }}
                />
              </div>
            ) : null}

            {selectedManagerId && !selectedCustomerId ? (
              <div className="mt-8 space-y-3">
                <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
                  <h4 className="text-sm font-semibold">
                    {t(
                      "reports.sections.helpedManagers.title",
                      "Help given to other customer managers",
                    )}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "reports.sections.helpedManagers.description",
                      "Hours this manager logged on customers owned by other customer managers.",
                    )}
                  </p>
                </div>

                <DataTable
                  columns={helpedCustomerManagersColumns}
                  data={helpedCustomerManagersRows}
                  loading={helpedCustomerManagersLoading}
                  hideRowCount
                  pageSize={12}
                  fixedColumnWidths={{ workloadPercentage: 200 }}
                  emptyState={{
                    icon: Filter,
                    title: t("reports.empty.noHelpedManagerRows.title", "No helped manager rows"),
                    description: t(
                      "reports.empty.noHelpedManagerRows.description",
                      "No customer-hour entries were found where this manager worked on other managers' customer scope.",
                    ),
                  }}
                />
              </div>
            ) : null}
          </section>

          {selectedManagerId && !selectedCustomerId ? renderArticleGroupsSection() : null}

          {selectedCustomerId ? (
            <div className="space-y-10">
              <section className="space-y-3">
                <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
                  <h3 className="text-base font-semibold">
                    {t("reports.sections.customerAccruals.title", "Customer Accruals")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedCustomer?.name ?? t("reports.selectedCustomer", "Selected customer")}
                  </p>
                </div>
                <DataTable
                  columns={customerAccrualColumns}
                  data={customerAccruals}
                  loading={accrualsLoading}
                  hideRowCount
                  pageSize={12}
                  emptyState={{
                    icon: Filter,
                    title: t("reports.empty.noContractAccruals.title", "No contract accruals"),
                    description: t(
                      "reports.empty.noContractAccruals.description",
                      "No contract accruals found for this customer.",
                    ),
                  }}
                />
              </section>

              <section className="space-y-3">
                <div className="space-y-1 border-t border-[#8b6f2a] pt-6">
                  <h3 className="text-base font-semibold">
                    {t("reports.sections.monthlyTurnoverAndHours.title", "Monthly turnover and hours")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedCustomer?.name ?? t("reports.selectedCustomer", "Selected customer")} ·{" "}
                    {rollingWindow.title}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Popover
                    open={monthlyArticleGroupFilterOpen}
                    onOpenChange={setMonthlyArticleGroupFilterOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="justify-between gap-2"
                        disabled={monthlyArticleGroupValues.length === 0}
                      >
                        <Filter className="size-4" />
                        {t(
                          "reports.filters.articleGroups.label",
                          "Article groups",
                        )}
                        <ChevronDown className="size-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[340px] p-0" align="start">
                      <Command>
                        <CommandInput
                          placeholder={t(
                            "reports.filters.articleGroups.search",
                            "Search article groups...",
                          )}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {t(
                              "reports.filters.articleGroups.none",
                              "No article groups found",
                            )}
                          </CommandEmpty>
                          {monthlyArticleGroupValues.map((groupValue) => {
                            const isSelected =
                              selectedMonthlyArticleGroupSet.has(groupValue);
                            return (
                              <CommandItem
                                key={groupValue}
                                value={monthlyArticleGroupLabel(groupValue)}
                                onSelect={() => {
                                  setSelectedMonthlyArticleGroups((current) => {
                                    if (current.includes(groupValue)) {
                                      if (current.length <= 1) return current;
                                      return current.filter(
                                        (value) => value !== groupValue,
                                      );
                                    }
                                    return [...current, groupValue];
                                  });
                                }}
                              >
                                <Check
                                  className={cn(
                                    "size-4",
                                    isSelected ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="truncate">
                                  {monthlyArticleGroupLabel(groupValue)}
                                </span>
                              </CommandItem>
                            );
                          })}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <span className="text-xs text-muted-foreground">
                    {monthlyArticleGroupSummaryLabel}
                  </span>
                </div>
                {customerMonthlyEconomicsLoading ? (
                  <Skeleton className="h-[420px] w-full" />
                ) : customerMonthlyEconomicsRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "reports.empty.noTurnoverOrHourData",
                      "No turnover or hour data found for this customer in the selected range.",
                    )}
                  </p>
                ) : (
                  <DataTable
                    columns={customerMonthlyEconomicsColumns}
                    data={customerMonthlyEconomicsRows}
                    loading={customerMonthlyEconomicsLoading}
                    hideRowCount
                    pageSize={Math.max(customerMonthlyEconomicsRows.length, 1)}
                    sortingStorageKey="reports.monthly-turnover-hours.sort"
                    emptyState={{
                      icon: Filter,
                      title: t("reports.empty.noMonthlyEconomics.title", "No monthly economics"),
                      description: t(
                        "reports.empty.noTurnoverOrHourData",
                        "No turnover or hour data found for this customer in the selected range.",
                      ),
                    }}
                  />
                )}
              </section>

              {renderArticleGroupsSection()}
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={timeDetailsOpen} onOpenChange={setTimeDetailsOpen}>
        <DialogContent className="flex h-[calc(100vh-8rem)] max-h-[calc(100vh-8rem)] w-[calc(100vw-8rem)] max-w-none flex-col sm:max-w-none">
          <DialogHeader>
            <DialogTitle>{timeDetailsTitle}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <DataTable
              columns={timeDetailsColumns}
              data={timeDetailsRows}
              loading={timeDetailsLoading}
              pageSize={15}
              emptyState={{
                icon: Filter,
                title: t("reports.empty.noMatchingRows.title", "No matching rows"),
                description: t("reports.empty.noMatchingRows.description", "No matching rows found."),
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={invoiceDetailsOpen} onOpenChange={setInvoiceDetailsOpen}>
        <DialogContent className="flex h-[calc(100vh-8rem)] max-h-[calc(100vh-8rem)] w-[calc(100vw-8rem)] max-w-none flex-col sm:max-w-none">
          <DialogHeader>
            <DialogTitle>{invoiceDetailsTitle}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <DataTable
              columns={invoiceDetailsColumns}
              data={filteredInvoiceDetailsRows}
              loading={invoiceDetailsLoading}
              pageSize={15}
              paginationExtra={
                invoiceDetailsMode === "status-list" ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t("reports.filters.status", "Status")}
                    </span>
                    <Select
                      value={invoiceDetailsStatusFilter}
                      onValueChange={(value) =>
                        setInvoiceDetailsStatusFilter(
                          value as "all" | "paid" | "pending",
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs" data-size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {t("reports.invoiceStatusFilter.all", "Both")}
                        </SelectItem>
                        <SelectItem value="paid">
                          {t("reports.invoiceStatus.paid", "Paid")}
                        </SelectItem>
                        <SelectItem value="pending">
                          {t("reports.invoiceStatus.pending", "Pending")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null
              }
              emptyState={{
                icon: Filter,
                title: t("reports.empty.noMatchingInvoices.title", "No matching invoices"),
                description: t(
                  "reports.empty.noMatchingInvoices.description",
                  "No matching invoices found for this month.",
                ),
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={contractDetailsOpen} onOpenChange={setContractDetailsOpen}>
        <DialogContent className="flex h-[calc(100vh-8rem)] max-h-[calc(100vh-8rem)] w-[calc(100vw-8rem)] max-w-none flex-col sm:max-w-none">
          <DialogHeader>
            <DialogTitle>{contractDetailsTitle}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <DataTable
              columns={customerAccrualColumns}
              data={contractDetailsRows}
              loading={contractDetailsLoading}
              pageSize={15}
              emptyState={{
                icon: Filter,
                title: t("reports.empty.noContractAccruals.title", "No contract accruals"),
                description: t(
                  "reports.empty.noContractAccrualRows.description",
                  "No contract accrual rows found for this customer.",
                ),
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
