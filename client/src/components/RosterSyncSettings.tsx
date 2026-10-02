import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Eye, RefreshCw, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/format";
import { isPortalAccessQuery } from "@/lib/portalAccess";
import { serverMessage } from "@/lib/serverMessage";
import type { RosterSyncHealth } from "@shared/rosterSheet";
import type { RosterReviewItem, RosterSyncRun } from "@shared/schema";

/** The status route's answer: the health, with the open review items in full rather than counted. */
interface RosterStatus extends Omit<RosterSyncHealth, "openReviews"> {
  sheet: { tab: string; serviceAccountEmail: string } | null;
  columns: string[];
  runs: RosterSyncRun[];
  openReviews: RosterReviewItem[];
  recentlyReviewed: RosterReviewItem[];
}

interface SyncResult {
  run: RosterSyncRun;
  creates: Array<{ row: number; name: string; email: string; house: string; returning: boolean }>;
  updates: Array<{ row: number; name: string; changes: Array<{ field: string; from: unknown; to: unknown; conflict: boolean }> }>;
  reviews: Array<{ kind: string; detail: string }>;
}

const STATUS_KEY = "/api/roster-sync/status";

const show = (value: unknown) => (value === null || value === "" ? "blank" : value === true ? "yes" : value === false ? "no" : String(value));

/**
 * The master resident sheet. Admins only.
 *
 * The sheet wins, but nothing is lost quietly: an edit it overwrites, a
 * returning resident's new stay, an active resident missing from the sheet
 * and a house it can't find all land in the review list here. "Preview" runs
 * the whole sync and changes nothing -- it is how the first sync is checked.
 * The CSV fallback takes the same columns through the same rules.
 */
export default function RosterSyncSettings() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const { data: status, isLoading } = useQuery<RosterStatus>({ queryKey: [STATUS_KEY] });

  const refresh = () => {
    for (const key of [STATUS_KEY, "/api/residents", "/api/action-items"]) queryClient.invalidateQueries({ queryKey: [key] });
    // A sync can end household logins (closeDepartedHouseholdLogins).
    queryClient.invalidateQueries({ predicate: isPortalAccessQuery });
  };
  const announce = (r: SyncResult) => {
    setResult(r);
    refresh();
    if (r.run.ok) {
      toast({
        title: r.run.dryRun ? "Preview ready — nothing was changed" : "Roster updated",
        description: `${r.run.rowsRead} rows read: ${r.run.created} to add, ${r.run.updated} to update, ${r.run.skipped} skipped.`,
      });
    } else {
      toast({ title: "The sync did not run", description: r.run.error ?? undefined, variant: "destructive" });
    }
  };

  const run = useMutation({
    mutationFn: async (dryRun: boolean) => (await (await apiRequest("POST", "/api/roster-sync/run", { dryRun })).json()) as SyncResult,
    onSuccess: announce,
    onError: (error) => toast({ title: "The sync did not run", description: serverMessage(error), variant: "destructive" }),
  });

  const csv = useMutation({
    mutationFn: async ({ file, dryRun }: { file: File; dryRun: boolean }) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/roster-sync/csv?dryRun=${dryRun}`, { method: "POST", body: form, credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "That file could not be read");
      }
      return (await res.json()) as SyncResult;
    },
    onSuccess: announce,
    onError: (error: Error) => toast({ title: "Could not read that file", description: error.message, variant: "destructive" }),
  });

  const review = useMutation({
    mutationFn: async (id: string) => await apiRequest("POST", `/api/roster-review-items/${id}/reviewed`),
    onSuccess: () => refresh(),
    onError: (error) => toast({ title: "Not marked", description: serverMessage(error), variant: "destructive" }),
  });

  const pickedFile = () => fileInput.current?.files?.[0];
  const openReviews = status?.openReviews ?? [];

  return (
    <Card id="roster" data-testid="card-roster-sync">
      <CardHeader>
        <CardTitle>Resident roster sheet</CardTitle>
        <p className="text-sm text-muted-foreground">
          Keeps the roster matching SPO's master Google Sheet, once a day. The sheet wins; anything it overwrites or can't
          place is listed below for review. Nobody is ever deleted.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !status ? (
          <LoadingState />
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="font-medium">The columns the portal reads</h3>
              <p className="text-sm text-muted-foreground">
                Exactly these headers, in any order. Every other column is ignored. A column that looks like bank, card or
                account details stops the whole sync.
              </p>
              <div className="flex flex-wrap gap-2">
                {status.columns.map((column) => (
                  <Badge key={column} variant="outline">
                    {column}
                  </Badge>
                ))}
              </div>
            </section>

            {!status.configured || !status.sheet ? (
              <p className="text-sm text-muted-foreground" data-testid="text-roster-not-configured">
                The Google Sheet isn't connected on this server yet. Whoever manages the server sets GOOGLE_SERVICE_ACCOUNT_JSON,
                RESIDENT_SHEET_ID and RESIDENT_SHEET_TAB (see docs/WORKFLOWS.md). Until then, the CSV import below takes the same
                columns.
              </p>
            ) : (
              <section className="space-y-3">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Tab</dt>
                    <dd className="mt-0.5 font-medium">{status.sheet.tab}</dd>
                    <dd className="text-xs text-muted-foreground">Shared (Viewer) with {status.sheet.serviceAccountEmail}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last successful sync</dt>
                    <dd className="mt-0.5 font-medium" data-testid="text-roster-last-sync">
                      {status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : "Not yet"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last run</dt>
                    <dd className="mt-0.5 text-sm">
                      {status.lastRun ? (
                        status.lastRun.ok ? (
                          "Finished"
                        ) : (
                          <span className="text-destructive">{status.lastRun.error}</span>
                        )
                      ) : (
                        "None yet"
                      )}
                    </dd>
                  </div>
                </dl>
                {!status.lastSuccessAt && (
                  <p className="text-sm text-muted-foreground" data-testid="text-roster-waiting">
                    Nothing has been applied yet. Preview the sheet, then press Sync now: the daily sync starts only after
                    that first Sync now.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => run.mutate(true)} disabled={run.isPending} data-testid="button-roster-preview">
                    <Eye className="mr-1 h-4 w-4" /> Preview (changes nothing)
                  </Button>
                  <Button variant="primary" onClick={() => run.mutate(false)} disabled={run.isPending} data-testid="button-roster-sync">
                    <RefreshCw className="mr-1 h-4 w-4" /> {run.isPending ? "Working…" : "Sync now"}
                  </Button>
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="font-medium">Import a CSV instead</h3>
              <p className="text-sm text-muted-foreground">
                For the current spreadsheet, before the master sheet exists: the same columns and the same rules. Preview first.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileInput} type="file" accept=".csv" className="text-sm" data-testid="input-roster-csv" />
                <Button
                  variant="secondary"
                  disabled={csv.isPending}
                  onClick={() => {
                    const file = pickedFile();
                    if (file) csv.mutate({ file, dryRun: true });
                  }}
                  data-testid="button-roster-csv-preview"
                >
                  <Eye className="mr-1 h-4 w-4" /> Preview file
                </Button>
                <Button
                  variant="secondary"
                  disabled={csv.isPending || !result?.run.dryRun || result.run.source !== "csv"}
                  onClick={() => {
                    const file = pickedFile();
                    if (file) csv.mutate({ file, dryRun: false });
                  }}
                  data-testid="button-roster-csv-apply"
                >
                  <Upload className="mr-1 h-4 w-4" /> Apply file
                </Button>
              </div>
            </section>

            {result && <SyncResultView result={result} />}

            <section className="space-y-2">
              <h3 className="font-medium">To review {openReviews.length > 0 && <Badge variant="warning">{openReviews.length}</Badge>}</h3>
              {openReviews.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-roster-no-reviews">
                  Nothing to review.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {openReviews.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 p-3" data-testid={`row-roster-review-${item.id}`}>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm">{item.detail}</p>
                        {item.kind === "conflict" && (
                          <p className="text-xs text-muted-foreground">
                            Was {show(item.oldValue)}, now {show(item.newValue)}
                            {item.editedByEmail ? ` · edited by ${item.editedByEmail}` : ""}
                            {item.editedAt ? ` on ${formatDateTime(item.editedAt)}` : ""}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</p>
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => review.mutate(item.id)} disabled={review.isPending}>
                        <Check className="mr-1 h-4 w-4" /> Reviewed
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {status.runs.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-medium">Recent runs</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-normal">When</th>
                        <th className="py-1 pr-3 font-normal">From</th>
                        <th className="py-1 pr-3 text-right font-normal">Rows</th>
                        <th className="py-1 pr-3 text-right font-normal">Added</th>
                        <th className="py-1 pr-3 text-right font-normal">Updated</th>
                        <th className="py-1 pr-3 text-right font-normal">Conflicts</th>
                        <th className="py-1 pr-3 text-right font-normal">Skipped</th>
                        <th className="py-1 font-normal">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {status.runs.map((r) => (
                        <tr key={r.id}>
                          <td className="py-1 pr-3">{formatDateTime(r.createdAt)}</td>
                          <td className="py-1 pr-3">
                            {r.source === "csv" ? "CSV" : "Sheet"}
                            {r.dryRun ? " (preview)" : ""}
                          </td>
                          <td className="py-1 pr-3 text-right">{r.rowsRead}</td>
                          <td className="py-1 pr-3 text-right">{r.created}</td>
                          <td className="py-1 pr-3 text-right">{r.updated}</td>
                          <td className="py-1 pr-3 text-right">{r.conflicts}</td>
                          <td className="py-1 pr-3 text-right">{r.skipped}</td>
                          <td className="py-1">{r.ok ? "OK" : <span className="text-destructive">{r.error}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SyncResultView({ result }: { result: SyncResult }) {
  const { run } = result;
  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="section-roster-result">
      <h3 className="font-medium">
        {run.dryRun ? "Preview" : "Result"} · {run.source === "csv" ? "CSV" : "sheet"} · {run.rowsRead} rows
      </h3>
      {!run.ok ? (
        <p className="text-sm text-destructive">{run.error}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {run.dryRun ? "Would add" : "Added"} {run.created}, {run.dryRun ? "would update" : "updated"} {run.updated}, {run.conflicts}{" "}
            conflict{run.conflicts === 1 ? "" : "s"}, {run.skipped} skipped.
          </p>
          {result.creates.length > 0 && (
            <ul className="space-y-0.5 text-sm">
              {result.creates.map((c) => (
                <li key={`c-${c.row}`}>
                  Row {c.row}: {run.dryRun ? "add" : "added"} {c.name} at {c.house}
                  {c.returning ? " (a new stay)" : ""}
                </li>
              ))}
            </ul>
          )}
          {result.updates.length > 0 && (
            <ul className="space-y-0.5 text-sm">
              {result.updates.map((u) => (
                <li key={`u-${u.row}`}>
                  Row {u.row}: {u.name} —{" "}
                  {u.changes.map((ch) => `${ch.field} ${show(ch.from)} → ${show(ch.to)}${ch.conflict ? " (over a portal edit)" : ""}`).join("; ")}
                </li>
              ))}
            </ul>
          )}
          {run.skippedRows.length > 0 && (
            <ul className="space-y-0.5 text-sm text-muted-foreground">
              {run.skippedRows.map((s) => (
                <li key={`s-${s.row}-${s.reason}`}>
                  Row {s.row} skipped: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
