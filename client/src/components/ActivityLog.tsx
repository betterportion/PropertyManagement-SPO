import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/states";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { formatDateTime, formatValue } from "@/lib/format";
import { AUDIT_ACTION_VALUES, auditActionLabel } from "@shared/audit";
import type { AuditEvent } from "@shared/schema";

/**
 * The activity trail, on the Settings page.
 *
 * Everything here is a convenience: `/api/audit-log` is administrator-only on
 * the server, and this page being hidden from everyone else is not what keeps
 * the trail private.
 *
 * The table grows for the life of the portal, so this only ever holds one page
 * of it. Filtering and paging happen on the server for the same reason -- there
 * is no point at which the whole trail is in the browser.
 */

const PAGE_SIZE = 25;

/** The Select value standing in for "no filter"; Radix forbids an empty one. */
const ANY_ACTION = "all";

interface AuditLogPage {
  events: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

interface Filters {
  from: string;
  to: string;
  actor: string;
  action: string;
}

const NO_FILTERS: Filters = { from: "", to: "", actor: "", action: ANY_ACTION };

/**
 * A date input reports every intermediate value as it is typed, so a reader
 * part-way through "2026-08-01" briefly holds a year like "60831". Sending
 * those to the server means a burst of refused requests behind a range nobody
 * asked for, so a half-typed date counts as no date at all.
 */
function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function buildQuery(filters: Filters, page: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (isCalendarDay(filters.from)) params.set("from", filters.from);
  if (isCalendarDay(filters.to)) params.set("to", filters.to);
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.action !== ANY_ACTION) params.set("action", filters.action);
  return params.toString();
}

export function ActivityLog() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // The filters the query uses lag the ones the inputs show. Both text boxes
  // and date pickers report every intermediate value, and a request per
  // keystroke would be a request per keystroke against a growing table.
  const [appliedFilters, setAppliedFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedFilters(filters), 300);
    return () => clearTimeout(timer);
  }, [filters]);

  const queryString = buildQuery(appliedFilters, page);

  const { data, isLoading, isError } = useQuery<AuditLogPage>({
    queryKey: ["/api/audit-log", queryString],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/audit-log?${queryString}`);
      return (await res.json()) as AuditLogPage;
    },
    // Without this the table empties out on every page change, which reads as
    // "there is nothing here" for as long as the request takes.
    placeholderData: keepPreviousData,
  });

  /** Any filter change starts again at the first page, never mid-way through. */
  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(1);
  };

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstOnPage = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastOnPage = Math.min(page * PAGE_SIZE, total);
  const hasFilters =
    Boolean(filters.from || filters.to || filters.actor.trim()) || filters.action !== ANY_ACTION;

  return (
    <Card className="p-4 sm:p-6 space-y-4" data-testid="card-activity-log">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <History className="h-5 w-5" />
          Activity Log
        </h2>
        <p className="text-sm text-muted-foreground">
          Who changed access, money or documents, newest first. Records are kept for two years;
          account and permission changes are kept permanently.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(event) => updateFilter("from", event.target.value)}
            data-testid="input-audit-from"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(event) => updateFilter("to", event.target.value)}
            data-testid="input-audit-to"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-actor">Person</Label>
          <Input
            id="audit-actor"
            placeholder="Email address"
            value={filters.actor}
            onChange={(event) => updateFilter("actor", event.target.value)}
            data-testid="input-audit-actor"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-action">Type of action</Label>
          <Select value={filters.action} onValueChange={(value) => updateFilter("action", value)}>
            <SelectTrigger id="audit-action" data-testid="select-audit-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_ACTION}>All activity</SelectItem>
              {AUDIT_ACTION_VALUES.map((action) => (
                <SelectItem key={action} value={action}>
                  {auditActionLabel(action)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {hasFilters && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFilters(NO_FILTERS);
              setPage(1);
            }}
            data-testid="button-audit-clear-filters"
          >
            Clear filters
          </Button>
        </div>
      )}

      {isError ? (
        <EmptyState
          title="The activity log could not be loaded"
          description="Adjust the filters or try again in a moment."
        />
      ) : (
        <DataTable
          // Columns are deliberately unsortable: the server returns one page of
          // a much longer list, already newest-first, and re-sorting those rows
          // in the browser would look like sorting the whole trail.
          columns={[
            {
              key: "when",
              header: "When",
              cell: (event) => formatDateTime(event.createdAt),
              className: "whitespace-nowrap",
            },
            {
              key: "who",
              header: "Who",
              // Shown exactly as recorded. The trail keeps no link to the
              // account, on purpose, so this may name somebody who has since
              // been deleted -- and that is the case it exists for.
              cell: (event) => formatValue(event.actorEmail ?? "The system"),
            },
            {
              key: "what",
              header: "What happened",
              cell: (event) => (
                <div className="space-y-0.5">
                  <div>{formatValue(event.summary ?? auditActionLabel(event.action))}</div>
                  <div className="text-xs text-muted-foreground">
                    {auditActionLabel(event.action)}
                  </div>
                </div>
              ),
            },
          ]}
          rows={events}
          getRowId={(event) => event.id}
          isLoading={isLoading}
          loadingMessage="Loading recent activity..."
          empty={
            <EmptyState
              title={hasFilters ? "No activity matches these filters" : "No activity recorded yet"}
              description={
                hasFilters
                  ? "Try a wider date range, a different person, or all activity."
                  : "Changes to accounts, invoices and documents will appear here as they happen."
              }
            />
          }
          data-testid="table-activity-log"
        />
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" data-testid="text-audit-range">
          {total === 0
            ? "Showing 0 of 0"
            : `Showing ${firstOnPage}\u2013${lastOnPage} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            data-testid="button-audit-previous"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground" data-testid="text-audit-page">
            Page {page} of {lastPage}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            disabled={page >= lastPage}
            data-testid="button-audit-next"
          >
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
