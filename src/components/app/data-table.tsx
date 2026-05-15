"use client"

import * as React from "react"
import {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type ColumnSizingState,
  type RowSelectionState,
  type Header,
  type Row,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { type LucideIcon, ChevronRight, ChevronUp, ChevronDown, ChevronLeft } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { DataTableToolbar } from "@/components/app/data-table-toolbar"
import { EmptyState } from "@/components/app/empty-state"
import { LoadingState } from "@/components/app/loading-state"

const DEFAULT_MIN_COL_WIDTH = 80
const DEFAULT_COL_SIZE = 150
const SELECT_COL_SIZE = 40

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  searchKey?: string
  searchPlaceholder?: string
  toolbarExtra?: React.ReactNode
  emptyState?: {
    icon: LucideIcon
    title: string
    description: string
    action?: { label: string; onClick: () => void }
  }
  loading?: boolean
  pageSize?: number
  onRowNavigate?: (row: TData) => void
  selectable?: boolean
  onSelectionChange?: (rows: TData[]) => void
  clearSelectionRef?: React.RefObject<(() => void) | null>
  hideRowCount?: boolean
  sortingStorageKey?: string
  pageSizeOptions?: number[]
  fixedColumnWidths?: Record<string, number>
  paginationExtra?: React.ReactNode
}

function getColumnWidthPercent<TData, TValue>(
  header: Header<TData, TValue>,
  totalSize: number
) {
  return `${(header.getSize() / totalSize) * 100}%`
}

function makeSelectColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: "_select",
    size: SELECT_COL_SIZE,
    minSize: SELECT_COL_SIZE,
    maxSize: SELECT_COL_SIZE,
    enableResizing: false,
    enableSorting: false,
    header: ({ table }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      </div>
    ),
    cell: ({ row }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      </div>
    ),
  }
}

function makeNavigateColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: "_navigate",
    size: SELECT_COL_SIZE,
    minSize: SELECT_COL_SIZE,
    maxSize: SELECT_COL_SIZE,
    enableResizing: false,
    enableSorting: false,
    header: () => null,
    cell: () => (
      <div className="flex items-center justify-center">
        <ChevronRight className="size-4 text-muted-foreground" />
      </div>
    ),
  }
}

function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  searchPlaceholder,
  toolbarExtra,
  emptyState,
  loading = false,
  pageSize = 20,
  onRowNavigate,
  selectable = false,
  onSelectionChange,
  clearSelectionRef,
  hideRowCount = false,
  sortingStorageKey,
  pageSizeOptions,
  fixedColumnWidths,
  paginationExtra,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [sortingHydrated, setSortingHydrated] = React.useState(false)
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({})
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})
  const lastSelectedIndex = React.useRef<number | null>(null)

  const allColumns = React.useMemo(() => {
    const cols: ColumnDef<TData, TValue>[] = selectable
      ? [makeSelectColumn<TData>() as ColumnDef<TData, TValue>, ...columns]
      : [...columns]
    if (onRowNavigate) {
      cols.push(makeNavigateColumn<TData>() as ColumnDef<TData, TValue>)
    }
    return cols
  }, [columns, selectable, onRowNavigate])

  const table = useReactTable({
    data,
    columns: allColumns,
    defaultColumn: {
      size: DEFAULT_COL_SIZE,
      minSize: DEFAULT_MIN_COL_WIDTH,
      sortUndefined: "last",
      sortingFn: "alphanumeric",
    },
    sortingFns: {
      alphanumeric: (rowA, rowB, columnId) => {
        const a = rowA.getValue(columnId)
        const b = rowB.getValue(columnId)
        const aStr = a == null ? "" : String(a).trim()
        const bStr = b == null ? "" : String(b).trim()
        const aEmpty = aStr === "" || aStr === "—"
        const bEmpty = bStr === "" || bStr === "—"
        if (aEmpty && bEmpty) return 0
        const desc = sorting.find((s) => s.id === columnId)?.desc ?? false
        if (aEmpty) return desc ? -1 : 1
        if (bEmpty) return desc ? 1 : -1
        return aStr.localeCompare(bStr, undefined, { numeric: true, sensitivity: "base" })
      },
    },
    state: { sorting, columnFilters, columnSizing, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    onRowSelectionChange: setRowSelection,
    columnResizeMode: "onChange",
    enableRowSelection: selectable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize },
    },
  })

  React.useEffect(() => {
    if (!selectable || !onSelectionChange) return
    const selectedRows = table
      .getFilteredSelectedRowModel()
      .rows.map((row: Row<TData>) => row.original)
    onSelectionChange(selectedRows)
  }, [rowSelection, selectable, onSelectionChange, table])

  const clearSelection = React.useCallback(() => {
    setRowSelection({})
  }, [])

  React.useEffect(() => {
    if (!sortingStorageKey) {
      setSortingHydrated(true)
      return
    }

    const raw = window.localStorage.getItem(sortingStorageKey)
    if (!raw) {
      setSortingHydrated(true)
      return
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            "id" in entry &&
            typeof (entry as { id: unknown }).id === "string",
        )
      ) {
        setSorting(parsed as SortingState)
      }
    } catch {
      window.localStorage.removeItem(sortingStorageKey)
    } finally {
      setSortingHydrated(true)
    }
  }, [sortingStorageKey])

  React.useEffect(() => {
    if (!sortingStorageKey || !sortingHydrated) return
    window.localStorage.setItem(sortingStorageKey, JSON.stringify(sorting))
  }, [sortingStorageKey, sorting, sortingHydrated])

  React.useEffect(() => {
    if (clearSelectionRef) {
      clearSelectionRef.current = clearSelection
    }
  }, [clearSelectionRef, clearSelection])

  React.useEffect(() => {
    table.setPageSize(pageSize)
  }, [table, pageSize])

  if (loading) {
    return <LoadingState rows={pageSize} columns={allColumns.length} />
  }

  const totalSize = table.getCenterTotalSize()
  const visibleLeafColumns = table.getVisibleLeafColumns()
  const fixedWidthByColumn = fixedColumnWidths ?? {}
  const fixedTotalWidth = visibleLeafColumns.reduce(
    (sum, column) => sum + (fixedWidthByColumn[column.id] ?? 0),
    0,
  )
  const nonFixedTotalSize = visibleLeafColumns.reduce(
    (sum, column) =>
      fixedWidthByColumn[column.id] == null ? sum + column.getSize() : sum,
    0,
  )

  function getHeaderWidth(header: Header<TData, unknown>) {
    const fixedWidth = fixedWidthByColumn[header.column.id]
    if (fixedWidth != null) {
      return `${fixedWidth}px`
    }

    if (fixedTotalWidth > 0 && nonFixedTotalSize > 0) {
      const ratio = header.getSize() / nonFixedTotalSize
      return `calc((100% - ${fixedTotalWidth}px) * ${ratio})`
    }

    return getColumnWidthPercent(header, totalSize)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {searchKey ? (
            <DataTableToolbar
              table={table}
              searchKey={searchKey}
              searchPlaceholder={searchPlaceholder}
            />
          ) : (
            <div />
          )}
          {toolbarExtra}
        </div>
        {(table.getPageCount() > 1 || paginationExtra) && (
          <div className="flex shrink-0 items-center gap-2">
            {paginationExtra}
            {table.getPageCount() > 1 && pageSizeOptions && pageSizeOptions.length > 0 ? (
              <select
                value={table.getState().pagination.pageSize}
                onChange={(event) => table.setPageSize(Number(event.target.value))}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                aria-label="Rows per page"
              >
                {pageSizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
            ) : null}
            {table.getPageCount() > 1 ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="rounded-md border">
        <Table style={{ width: "100%", tableLayout: "fixed" }}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isControlHeader =
                    header.column.id === "_select" || header.column.id === "_navigate"
                  const sortDir = header.column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: getHeaderWidth(header) }}
                      className={isControlHeader ? "relative p-0" : "relative"}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <div
                          className="flex cursor-pointer select-none items-center gap-1 overflow-hidden text-ellipsis text-sm text-muted-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <div className="flex shrink-0 flex-col">
                            <ChevronUp className={`size-3 -mb-0.5 ${sortDir === "asc" ? "text-foreground" : "opacity-30"}`} />
                            <ChevronDown className={`size-3 -mt-0.5 ${sortDir === "desc" ? "text-foreground" : "opacity-30"}`} />
                          </div>
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                        </div>
                      ) : (
                        <div className="overflow-hidden text-ellipsis text-sm text-muted-foreground">
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                        </div>
                      )}
                      {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => header.column.resetSize()}
                        className={`absolute right-0 top-0 h-full w-3 -translate-x-1/2 cursor-col-resize select-none touch-none ${
                          header.column.getIsResizing()
                            ? "bg-primary"
                            : "bg-transparent hover:bg-border"
                        }`}
                        style={{ zIndex: 1 }}
                      />
                    )}
                  </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => {
                    const isSelectCell = cell.column.id === "_select"
                    const isNavigateCell = cell.column.id === "_navigate"
                    const isControlCell = isSelectCell || isNavigateCell
                    return (
                      <TableCell
                        key={cell.id}
                        className={
                          isControlCell ? "p-0 cursor-pointer" : undefined
                        }
                        onClick={
                          isSelectCell
                            ? (e) => {
                                e.stopPropagation()
                                const rows = table.getRowModel().rows
                                const currentIndex = rows.indexOf(row)

                                if (
                                  e.shiftKey &&
                                  lastSelectedIndex.current !== null &&
                                  lastSelectedIndex.current !== currentIndex
                                ) {
                                  const start = Math.min(lastSelectedIndex.current, currentIndex)
                                  const end = Math.max(lastSelectedIndex.current, currentIndex)
                                  const next: RowSelectionState = { ...rowSelection }
                                  for (let i = start; i <= end; i++) {
                                    next[rows[i].id] = true
                                  }
                                  setRowSelection(next)
                                } else {
                                  row.toggleSelected(!row.getIsSelected())
                                }

                                lastSelectedIndex.current = currentIndex
                              }
                            : isNavigateCell
                              ? (e) => {
                                  e.stopPropagation()
                                  onRowNavigate?.(row.original)
                                }
                              : undefined
                        }
                      >
                        <div className="overflow-hidden text-ellipsis">
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </div>
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={allColumns.length}
                  className="h-24 text-center"
                >
                  {emptyState ? (
                    <EmptyState {...emptyState} />
                  ) : (
                    "No results."
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {!hideRowCount ? (
        <div className="flex items-center justify-between px-2">
          <p className="text-sm text-muted-foreground">
            {selectable && Object.keys(rowSelection).length > 0
              ? `${Object.keys(rowSelection).length} of ${table.getFilteredRowModel().rows.length} row(s) selected`
              : `${table.getFilteredRowModel().rows.length} row(s)`}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export { DataTable, type DataTableProps }
