import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleDashed } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format";
import { RESIDENT_DOCUMENTS, summarizeResidentDocuments } from "@shared/residentDocuments";
import type { Resident, ResidentDocument } from "@shared/schema";

/**
 * Which of a resident's paperwork is in.
 *
 * **This is not e-signature, and it must not be mistaken for one.** An RA
 * records that a document was signed and when; the signing itself happens on
 * paper or wherever SPO already does it. A checkbox pretending to be a
 * signature would be worse than nothing — it would read as evidence in a
 * dispute and be nothing of the sort. The copy on screen says so.
 *
 * Only a **date** counts as signed. A row existing means somebody looked, not
 * that anybody signed, which is why clearing the date is always available:
 * correcting a mistake has to be possible.
 */

/** Today as "YYYY-MM-DD"; paperwork is usually recorded the day it comes in. */
const today = () => new Date().toISOString().slice(0, 10);

export default function ResidentPaperwork({
  resident,
  canManage,
}: {
  resident: Resident;
  canManage: boolean;
}) {
  const { toast } = useToast();

  const { data: all = [], isLoading } = useQuery<ResidentDocument[]>({
    queryKey: ["/api/resident-documents"],
  });

  const rows = useMemo(
    () => all.filter((row) => row.residentId === resident.id),
    [all, resident.id],
  );
  const byKey = useMemo(() => new Map(rows.map((row) => [row.documentKey, row])), [rows]);
  const summary = summarizeResidentDocuments(rows);

  const setDocument = useMutation({
    mutationFn: async (vars: { key: string; signedOn: string | null }) =>
      await apiRequest("PUT", `/api/residents/${resident.id}/documents/${vars.key}`, {
        signedOn: vars.signedOn,
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/resident-documents"] });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "The paperwork was not changed. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>
          Paperwork — {resident.firstName} {resident.lastName}
        </CardTitle>
        <Badge
          variant={summary.complete ? "success" : "warning"}
          data-testid={`badge-paperwork-${resident.id}`}
        >
          {summary.signed} of {summary.total} signed
        </Badge>
      </CardHeader>

      <CardContent className="space-y-1">
        <p className="pb-2 text-sm text-muted-foreground">
          Recorded by an RA, not signed here. This says what came in and when — it is not an
          electronic signature and should never be relied on as one.
        </p>

        {isLoading ? (
          <LoadingState message="Loading paperwork..." />
        ) : (
          RESIDENT_DOCUMENTS.map((document) => {
            const row = byKey.get(document.key);
            const signed = !!row?.signedOn;
            return (
              <div
                key={document.key}
                className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
                data-testid={`row-paperwork-${document.key}`}
              >
                {signed ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                ) : (
                  <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                )}

                <div className="min-w-0 flex-1">
                  <p className="font-medium">{document.label}</p>
                  <p className="text-sm text-muted-foreground">{document.hint}</p>
                  {signed && (
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      data-testid={`text-paperwork-signed-${document.key}`}
                    >
                      Signed {formatDate(row!.signedOn)}
                      {/* The email is kept on the row so this still says who
                          recorded it after that account is gone. */}
                      {row?.recordedByEmail ? ` · recorded by ${row.recordedByEmail}` : ""}
                    </p>
                  )}
                </div>

                {canManage && (
                  <Button
                    size="sm"
                    variant={signed ? "ghost" : "secondary"}
                    onClick={() =>
                      setDocument.mutate({ key: document.key, signedOn: signed ? null : today() })
                    }
                    data-testid={`button-paperwork-${document.key}`}
                  >
                    {signed ? "Mark not signed" : "Mark signed today"}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
