import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/states";

/**
 * One shared table for every list in the portal — §6 of the SPO design system.
 *
 * Rules it enforces so tables cannot drift apart:
 *  - Sortable headers are buttons with a visible direction indicator.
 *  - Numbers and money are right-aligned; text is left-aligned.
 *  - Missing values are the caller's job to format (use `formatValue`).
 *  - Loading and empty states are rendered inside the table frame.
 */

export type SortValue = string | number | Date | null | undefined;

export interface DataTableColumn<T> {
  /** Stable id, also used as the sort key. */
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Return the value to sort on. Omit to make the column unsortable. */
  sortValue?: (row: T) => SortValue;
  align?: "left" | "right" | "center";
  /** Extra classes for both the header cell and body cells. */
  className?: string;
  /** Hide below the `md` breakpoint to keep phone tables readable. */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  getRowId: (row: T) => string;
  /** Column key + direction the table opens with. */
  defaultSort?: { key: string; direction?: "asc" | "desc" };
  isLoading?: boolean;
  loadingMessage?: string;
  /** Shown in place of rows when there are none — pass an <EmptyState />. */
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** Applied to the wrapping element for test hooks. */
  "data-testid"?: string;
  className?: string;
}

const alignClass = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

function isMissing(value: SortValue) {
  return value === null || value === undefined || value === "";
}

function compare(a: SortValue, b: SortValue): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  const aValue = a instanceof Date ? a.getTime() : a;
  const bValue = b instanceof Date ? b.getTime() : b;

  if (typeof aValue === "number" && typeof bValue === "number") {
    return aValue - bValue;
  }
  return String(aValue).localeCompare(String(bValue), "en-US", {
    numeric: true,
    sensitivity: "base",
  });
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  defaultSort,
  isLoading,
  loadingMessage,
  empty,
  onRowClick,
  className,
  ...rest
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<{ key: string; direction: "asc" | "desc" } | null>(
    defaultSort ? { key: defaultSort.key, direction: defaultSort.direction ?? "asc" } : null,
  );

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    const read = column.sortValue;
    // Copy first — Array.prototype.sort mutates, and `rows` is query cache data.
    return [...rows].sort((a, b) => {
      const aValue = read(a);
      const bValue = read(b);
      const aMissing = isMissing(aValue);
      const bMissing = isMissing(bValue);
      // Missing values stay at the bottom whichever way the column is sorted.
      if (aMissing || bMissing) return compare(aValue, bValue);
      return compare(aValue, bValue) * factor;
    });
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  };

  const body = () => {
    if (isLoading) {
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={columns.length} className="p-0">
            <LoadingState message={loadingMessage ?? "Loading..."} className="h-40" />
          </TableCell>
        </TableRow>
      );
    }
    if (sorted.length === 0) {
      return (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={columns.length} className="p-0">
            {empty}
          </TableCell>
        </TableRow>
      );
    }
    return sorted.map((row) => (
      <TableRow
        key={getRowId(row)}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        className={cn(onRowClick && "cursor-pointer")}
        data-testid={`row-${getRowId(row)}`}
      >
        {columns.map((column) => (
          <TableCell
            key={column.key}
            className={cn(
              alignClass[column.align ?? "left"],
              column.hideOnMobile && "hidden md:table-cell",
              column.className,
            )}
          >
            {column.cell(row)}
          </TableCell>
        ))}
      </TableRow>
    ));
  };

  return (
    <div className={cn("w-full overflow-x-auto", className)} {...rest}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const sortable = Boolean(column.sortValue);
              const active = sort?.key === column.key;
              return (
                <TableHead
                  key={column.key}
                  aria-sort={
                    active ? (sort!.direction === "asc" ? "ascending" : "descending") : undefined
                  }
                  className={cn(
                    alignClass[column.align ?? "left"],
                    column.hideOnMobile && "hidden md:table-cell",
                    column.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={cn(
                        "-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        column.align === "right" && "flex-row-reverse",
                        active && "text-foreground",
                      )}
                      data-testid={`sort-${column.key}`}
                    >
                      {column.header}
                      {active ? (
                        sort!.direction === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>{body()}</TableBody>
      </Table>
    </div>
  );
}
