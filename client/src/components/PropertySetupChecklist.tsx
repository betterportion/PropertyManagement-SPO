import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleDashed, MinusCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/format";
import {
  SETUP_ITEM_STATUS_LABEL,
  setupItemsFor,
  summarizeSetup,
  type SetupItemStatus,
} from "@shared/propertySetup";
import type { Property, PropertySetupItem } from "@shared/schema";

/**
 * What has to happen when SPO takes on a house, and where each of those things
 * stands.
 *
 * Three states per item, and the third is the point: an item that does not
 * apply to this house has to be sayable without marking it done, or the record
 * claims work happened that never did. Insurance on a house whose rental
 * company carries it is the case that forced it.
 *
 * The counts come from `summarizeSetup`, shared with the server, so this card,
 * the badge on the property list row and the dashboard action item cannot
 * disagree about how much is left.
 */

const STATUS_ICON = {
  open: CircleDashed,
  done: Check,
  not_applicable: MinusCircle,
} as const;

export default function PropertySetupChecklist({
  property,
  canManage,
}: {
  property: Property;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const [openNoteFor, setOpenNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const { data: rows = [], isLoading } = useQuery<PropertySetupItem[]>({
    queryKey: ["/api/properties", property.id, "setup"],
  });

  // Rows store a user id; a person reads a name. Only staff can reach this
  // card at all, and only an account holding canManageUsers can read the list
  // — everyone else simply sees the date without a name rather than a broken
  // card, which is why the failure here is silent by design.
  const { data: staff = [] } = useQuery<Array<{ id: string; firstName?: string | null; lastName?: string | null; email?: string | null }>>({
    queryKey: ["/api/users"],
    retry: false,
  });

  const setterName = (userId: string | null | undefined) => {
    if (!userId) return null;
    const person = staff.find((candidate) => candidate.id === userId);
    if (!person) return null;
    const name = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
    return name || person.email || null;
  };

  const definitions = useMemo(() => setupItemsFor(property.ownership), [property.ownership]);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.itemKey, row])), [rows]);
  const summary = useMemo(() => summarizeSetup(rows, property.ownership), [rows, property.ownership]);

  const setItem = useMutation({
    mutationFn: async (vars: { itemKey: string; status: SetupItemStatus; note: string | null }) =>
      await apiRequest("PUT", `/api/properties/${property.id}/setup/${vars.itemKey}`, {
        status: vars.status,
        note: vars.note,
      }),
    // staleTime is Infinity and nothing refetches on its own, so the list has
    // to be invalidated by hand — and so does the dashboard, whose one
    // aggregated item clears when the last check resolves.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/properties", property.id, "setup"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
    },
    onError: () => {
      toast({
        title: "That did not save",
        description: "The checklist item was not changed. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const setStatus = (itemKey: string, status: SetupItemStatus) => {
    const existing = byKey.get(itemKey);
    setItem.mutate({ itemKey, status, note: existing?.note ?? null });
  };

  const saveNote = (itemKey: string) => {
    const existing = byKey.get(itemKey);
    setItem.mutate({
      itemKey,
      status: existing?.status ?? "open",
      note: noteDraft.trim() || null,
    });
    setOpenNoteFor(null);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Setting this house up</CardTitle>
        {summary.tracked ? (
          <Badge
            variant={summary.complete ? "success" : "warning"}
            data-testid="badge-setup-summary"
          >
            {summary.complete
              ? "All set up"
              : `${summary.open} of ${summary.total} still to do`}
          </Badge>
        ) : (
          <Badge variant="secondary" data-testid="badge-setup-summary">
            Not tracked yet
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-1">
        {!summary.tracked && (
          <p className="pb-3 text-sm text-muted-foreground" data-testid="text-setup-untracked">
            Nothing has been recorded for this house yet — either it predates the checklist, or it
            never got one. Setting any item below starts tracking it; until then it stays off the
            dashboard rather than showing as a list of things nobody has done.
          </p>
        )}

        {isLoading ? (
          <LoadingState message="Loading the checklist..." />
        ) : (
          definitions.map((definition) => {
            const row = byKey.get(definition.key);
            const status: SetupItemStatus = row?.status ?? "open";
            const Icon = STATUS_ICON[status];
            const isEditingNote = openNoteFor === definition.key;

            return (
              <div
                key={definition.key}
                className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
                data-testid={`row-setup-${definition.key}`}
              >
                <Icon
                  className={
                    status === "done"
                      ? "mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                      : status === "not_applicable"
                        ? "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                        : "mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                  }
                  aria-hidden
                />

                <div className="min-w-0 flex-1">
                  <p className="font-medium">{definition.label}</p>
                  <p className="text-sm text-muted-foreground">{definition.hint}</p>

                  {row?.note && !isEditingNote && (
                    <p className="mt-1 text-sm" data-testid={`text-setup-note-${definition.key}`}>
                      {row.note}
                    </p>
                  )}

                  {/* Who set it and when. This is the question that actually
                      gets asked — "who said the gas was on?" */}
                  {row?.setAt && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-setup-set-${definition.key}`}>
                      {SETUP_ITEM_STATUS_LABEL[status]} on {formatDate(row.setAt)}
                      {/* Who, not just when. "Who said the gas was on" is the
                          question this record exists to answer, and a date
                          alone cannot answer it. */}
                      {setterName(row.setByUserId) ? ` by ${setterName(row.setByUserId)}` : ""}
                    </p>
                  )}

                  {isEditingNote && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        autoFocus
                        value={noteDraft}
                        maxLength={500}
                        placeholder="Anything the next RA should know"
                        onChange={(event) => setNoteDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveNote(definition.key);
                          if (event.key === "Escape") setOpenNoteFor(null);
                        }}
                        data-testid={`input-setup-note-${definition.key}`}
                      />
                      <Button size="sm" onClick={() => saveNote(definition.key)}>
                        Save
                      </Button>
                    </div>
                  )}
                </div>

                {canManage && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {(["open", "done", "not_applicable"] as const).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant={status === option ? "primary" : "ghost"}
                        onClick={() => setStatus(definition.key, option)}
                        data-testid={`button-setup-${definition.key}-${option}`}
                      >
                        {SETUP_ITEM_STATUS_LABEL[option]}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setNoteDraft(byKey.get(definition.key)?.note ?? "");
                        setOpenNoteFor(isEditingNote ? null : definition.key);
                      }}
                      data-testid={`button-setup-note-${definition.key}`}
                    >
                      Note
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
