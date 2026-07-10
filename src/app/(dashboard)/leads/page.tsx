"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Inbox,
  Building2,
  Clock,
  Hash,
  Plus,
  UserPen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { WebsiteLead, WebsiteLeadStatus } from "@/types/database";
import { AddLeadDialog } from "@/components/app/add-lead-dialog";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { EmptyState } from "@/components/app/empty-state";
import { SearchInput } from "@/components/app/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/hooks/use-user";
import { useTranslation } from "@/hooks/use-translation";
import { useCachedData } from "@/hooks/use-cached-data";

const STATUS_LABEL: Record<WebsiteLeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  offer_sent: "Offer sent",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
  spam: "Spam",
};

// Column order = the pipeline left→right, with the "dead" buckets (archived,
// spam) set apart at the far right and de-emphasized so the active flow reads
// cleanly. `gap` inserts a little separation before the bucket.
const COLUMNS: Array<{
  status: WebsiteLeadStatus;
  muted?: boolean;
  gap?: boolean;
}> = [
  { status: "new" },
  { status: "contacted" },
  { status: "offer_sent" },
  { status: "won" },
  { status: "lost" },
  { status: "archived", muted: true, gap: true },
  { status: "spam", muted: true },
];

function formatDate(value: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Within-column ordering: manually-positioned cards first (ascending), then any
 * never-ordered cards by recency (newest first), with a stable id tiebreak.
 * Mirrors the engagement board's compareInColumn.
 */
function compareInColumn(a: WebsiteLead, b: WebsiteLead): number {
  const pa = a.board_position ?? null;
  const pb = b.board_position ?? null;
  if (pa != null && pb != null && pa !== pb) return pa - pb;
  if (pa != null && pb == null) return -1;
  if (pa == null && pb != null) return 1;
  if (pa == null && pb == null) {
    const byRecency = (b.submitted_at ?? b.created_at).localeCompare(
      a.submitted_at ?? a.created_at,
    );
    if (byRecency !== 0) return byRecency;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Read the live card DOM in a column to work out, for a given cursor Y:
 *   • `lineIndex` — the gap the drop-guide line should sit in (0 = above the
 *     first card … N = below the last).
 *   • `beforeId`  — the card to drop AFTER (null = drop at top), skipping the
 *     dragged card itself. Both the guide and the drop derive from this.
 */
function computeDropLine(
  container: HTMLElement,
  clientY: number,
  draggedId: string | null,
): { lineIndex: number; beforeId: string | null } {
  const cardEls = Array.from(
    container.querySelectorAll<HTMLElement>("[data-card-id]"),
  );
  const ids = cardEls.map((el) => el.dataset.cardId ?? "");
  let lineIndex = 0;
  for (const el of cardEls) {
    const r = el.getBoundingClientRect();
    if (clientY > r.top + r.height / 2) lineIndex += 1;
    else break;
  }
  let beforeId = lineIndex > 0 ? ids[lineIndex - 1] : null;
  if (beforeId === draggedId) beforeId = lineIndex >= 2 ? ids[lineIndex - 2] : null;
  return { lineIndex, beforeId };
}

type LeadsPayload = { leads: WebsiteLead[] };

export default function LeadsPage() {
  const { user } = useUser();
  const { t } = useTranslation();
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<WebsiteLead | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] =
    React.useState<WebsiteLeadStatus | null>(null);
  // Which gap the drop-guide line is drawn in: { status, line }.
  const [dropTarget, setDropTarget] = React.useState<{
    status: WebsiteLeadStatus;
    line: number;
  } | null>(null);

  const statusLabel = React.useCallback(
    (status: WebsiteLeadStatus) =>
      t(`leads.status.${status}`, STATUS_LABEL[status]),
    [t],
  );

  const fetchLeads = React.useCallback(async (): Promise<LeadsPayload> => {
    const response = await fetch("/api/leads", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as {
      leads?: WebsiteLead[];
      error?: string;
    } | null;
    if (!response.ok) {
      toast.error(
        payload?.error ?? t("leads.toast.loadFailed", "Failed to load leads"),
      );
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
    if (!search) return leads;
    const query = search.toLowerCase();
    return leads.filter((lead) =>
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
  }, [leads, search]);

  const leadsByStatus = React.useMemo(() => {
    const map = new Map<WebsiteLeadStatus, WebsiteLead[]>();
    for (const col of COLUMNS) map.set(col.status, []);
    for (const lead of filteredLeads) {
      if (!map.has(lead.status)) map.set(lead.status, []);
      map.get(lead.status)!.push(lead);
    }
    for (const list of map.values()) list.sort(compareInColumn);
    return map;
  }, [filteredLeads]);

  // The column (status) the dragged card currently lives in — drives whether a
  // hover is a cross-column move (→ top) or an in-column reorder (→ cursor gap).
  const draggedColumn = React.useCallback((): WebsiteLeadStatus | null => {
    if (!draggingId) return null;
    return leads.find((l) => l.id === draggingId)?.status ?? null;
  }, [draggingId, leads]);

  const handleCardDragEnd = React.useCallback(() => {
    setDraggingId(null);
    setDragOverStatus(null);
    setDropTarget(null);
  }, []);

  // Unified drop handler: cross-column moves change status (+ auto-log), and
  // both cross- and in-column drops persist the destination column's new order.
  const handleDrop = React.useCallback(
    async (
      e: React.DragEvent<HTMLDivElement>,
      toStatus: WebsiteLeadStatus,
    ) => {
      const id = draggingId;
      setDraggingId(null);
      setDragOverStatus(null);
      setDropTarget(null);
      if (!id) return;

      const current = leads;
      const dragged = current.find((l) => l.id === id);
      if (!dragged) return;
      const fromStatus = dragged.status;
      const crossColumn = fromStatus !== toStatus;

      // Anchor the insert to a real neighbour from what's rendered, so ordering
      // is correct even when search hides cards. Cross-column drops land on top.
      const beforeId = crossColumn
        ? null
        : computeDropLine(e.currentTarget, e.clientY, id).beforeId;

      const destExisting = current
        .filter((l) => l.id !== id && l.status === toStatus)
        .sort(compareInColumn);
      const insertAt = beforeId
        ? destExisting.findIndex((l) => l.id === beforeId) + 1
        : 0;
      const newOrderIds = [
        ...destExisting.slice(0, insertAt).map((l) => l.id),
        id,
        ...destExisting.slice(insertAt).map((l) => l.id),
      ];

      // No-op: same column and order unchanged — skip the round-trip.
      if (!crossColumn) {
        const currentOrder = current
          .filter((l) => l.status === toStatus)
          .sort(compareInColumn)
          .map((l) => l.id);
        if (
          currentOrder.length === newOrderIds.length &&
          currentOrder.every((rid, i) => rid === newOrderIds[i])
        ) {
          return;
        }
      }

      const positionById = new Map(newOrderIds.map((rid, i) => [rid, i + 1]));
      const snapshot = current;
      setData((prev) => ({
        leads: (prev?.leads ?? []).map((l) => {
          if (!positionById.has(l.id)) return l;
          const next =
            l.id === id && crossColumn ? { ...l, status: toStatus } : { ...l };
          next.board_position = positionById.get(l.id)!;
          return next;
        }),
      }));

      const supabase = createClient();
      if (crossColumn) {
        const { data: updated, error } = await supabase
          .from("website_leads")
          .update({ status: toStatus } as never)
          .eq("id", id)
          .select("id");
        if (error || !updated?.length) {
          setData({ leads: snapshot });
          toast.error(t("leads.board.moveFailed", "Couldn't move lead"));
          return;
        }
        // Best-effort history entry; a failed log doesn't roll back the move.
        const { error: logError } = await supabase
          .from("lead_activities")
          .insert({
            lead_id: id,
            activity_type: "status_change",
            note: `${statusLabel(fromStatus)} → ${statusLabel(toStatus)}`,
            created_by: user.id,
          } as never);
        if (logError) {
          toast.warning(
            t(
              "leads.board.moveLogFailed",
              "Moved, but couldn't log the change",
            ),
          );
        } else {
          toast.success(
            `${t("leads.board.movedTo", "Moved to")} ${statusLabel(toStatus)}`,
          );
        }
      }

      const { error: reorderError } = await supabase.rpc(
        "reorder_leads" as never,
        { p_ids: newOrderIds } as never,
      );
      if (reorderError) {
        setData({ leads: snapshot });
        toast.error(t("leads.board.moveFailed", "Couldn't move lead"));
      }
    },
    [draggingId, leads, setData, statusLabel, t, user.id],
  );

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("leads.searchPlaceholder", "Search leads...")}
          className="w-full sm:max-w-sm"
        />
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          {t("leads.add.button", "Add lead")}
        </Button>
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

      {loading || (refreshing && leads.length === 0) ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-64 w-[270px] shrink-0 rounded-lg"
            />
          ))}
        </div>
      ) : leads.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("leads.empty.title", "No leads")}
          description={t(
            "leads.empty.description",
            "Leads submitted on the website will appear here.",
          )}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const colLeads = leadsByStatus.get(col.status) ?? [];
            return (
              <div
                key={col.status}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverStatus(col.status);
                  const line =
                    draggedColumn() === col.status
                      ? computeDropLine(e.currentTarget, e.clientY, draggingId)
                          .lineIndex
                      : 0; // cross-column drops always land at the top
                  setDropTarget((cur) =>
                    cur && cur.status === col.status && cur.line === line
                      ? cur
                      : { status: col.status, line },
                  );
                }}
                onDragLeave={(e) => {
                  if (
                    !e.currentTarget.contains(e.relatedTarget as Node | null)
                  ) {
                    setDragOverStatus((cur) =>
                      cur === col.status ? null : cur,
                    );
                    setDropTarget((cur) =>
                      cur?.status === col.status ? null : cur,
                    );
                  }
                }}
                onDrop={(e) => handleDrop(e, col.status)}
                className={cn(
                  "flex w-[270px] shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors",
                  dragOverStatus === col.status &&
                    "border-primary bg-primary/10 ring-2 ring-primary/40 ring-inset",
                  col.muted && "border-dashed bg-transparent opacity-70",
                  col.gap && "ml-3",
                )}
              >
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      col.muted && "text-muted-foreground",
                    )}
                  >
                    {statusLabel(col.status)}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">
                    {colLeads.length}
                  </Badge>
                </div>
                <div className="flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {colLeads.map((lead, i) => {
                    const showLine =
                      dropTarget?.status === col.status && dropTarget.line === i;
                    return (
                      <React.Fragment key={lead.id}>
                        {showLine ? <DropLine /> : null}
                        <LeadCard
                          lead={lead}
                          dragging={draggingId === lead.id}
                          onDragStart={setDraggingId}
                          onDragEnd={handleCardDragEnd}
                          onClick={(id) => router.push(`/leads/${id}`)}
                          onDelete={setDeleteTarget}
                          manualLabel={t("leads.source.manual", "Manual")}
                          deleteLabel={t("leads.detail.delete", "Delete lead")}
                        />
                      </React.Fragment>
                    );
                  })}
                  {dropTarget?.status === col.status &&
                  dropTarget.line === colLeads.length ? (
                    <DropLine />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The drop-position guide: a thin accented bar marking where the card will land.
function DropLine() {
  return (
    <div className="relative h-0.5 rounded-full bg-primary" aria-hidden>
      <span className="absolute -left-0.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
    </div>
  );
}

const LeadCard = React.memo(function LeadCard({
  lead,
  dragging,
  onDragStart,
  onDragEnd,
  onClick,
  onDelete,
  manualLabel,
  deleteLabel,
}: {
  lead: WebsiteLead;
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onClick: (id: string) => void;
  onDelete: (lead: WebsiteLead) => void;
  manualLabel: string;
  deleteLabel: string;
}) {
  return (
    <div
      draggable
      data-card-id={lead.id}
      onDragStart={() => onDragStart(lead.id)}
      onDragEnd={onDragEnd}
      onClick={() => onClick(lead.id)}
      className={cn(
        "group cursor-pointer rounded-md border bg-background p-2.5 text-left shadow-sm transition-opacity hover:border-border-strong",
        "[content-visibility:auto] [contain-intrinsic-size:auto_110px]",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {lead.name}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {lead.source === "manual" ? (
            <Badge variant="outline" className="gap-1 font-normal text-[10px]">
              <UserPen className="size-3" />
              {manualLabel}
            </Badge>
          ) : null}
          <button
            type="button"
            aria-label={deleteLabel}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(lead);
            }}
            className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Building2 className="size-3.5 shrink-0" />
        <span className="truncate">{lead.company}</span>
      </p>
      {lead.org_number ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Hash className="size-3.5 shrink-0" />
          <span className="truncate">{lead.org_number}</span>
        </p>
      ) : null}
      {lead.message ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
          {lead.message}
        </p>
      ) : null}
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="size-3 shrink-0" />
        {formatDate(lead.submitted_at ?? lead.created_at)}
      </p>
    </div>
  );
});
