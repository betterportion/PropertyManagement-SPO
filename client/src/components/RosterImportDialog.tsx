import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from "lucide-react";
import type { Property } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

/**
 * Importing a house's roster from a spreadsheet.
 *
 * The shape of this dialog is the feature: an upload only ever produces a
 * preview, and nothing is created until somebody reads that preview and
 * confirms it. Eight housemates arriving every August is the case it exists
 * for, and getting half of them silently wrong is what would stop it being
 * used a second time.
 */

type RowOutcomeKind = "create" | "duplicate" | "error";

interface ParsedRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  notes: string | null;
  moveInDate: string | null;
}

interface RowOutcome {
  row: ParsedRow;
  kind: RowOutcomeKind;
  reason?: string;
}

interface ImportPreview {
  fileErrors: string[];
  outcomes: RowOutcome[];
  counts: Record<RowOutcomeKind, number>;
}

const OUTCOME_STYLES: Record<RowOutcomeKind, { label: string; className: string }> = {
  // Every one of these carries a word as well as a colour: status is never
  // conveyed by colour alone.
  create: { label: "Will be added", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" },
  duplicate: { label: "Already on roster", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" },
  error: { label: "Needs fixing", className: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" },
};

export function RosterImportDialog({
  properties,
  onImported,
}: {
  properties: Property[];
  onImported: () => void;
}) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const reset = () => {
    setPropertyId("");
    setFileName(null);
    setPreview(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const previewMutation = useMutation({
    mutationFn: async (file: File): Promise<ImportPreview> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/properties/${propertyId}/residents/import/preview`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "That file could not be read");
      }
      return res.json();
    },
    onSuccess: (result) => setPreview(result),
    onError: (error: Error) => {
      setFileName(null);
      if (fileInput.current) fileInput.current.value = "";
      toast({ title: "Could not read that file", description: error.message, variant: "destructive" });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (rows: ParsedRow[]) => {
      const res = await apiRequest("POST", `/api/properties/${propertyId}/residents/import`, {
        rows: rows.map(({ firstName, lastName, email, phone, notes, moveInDate }) => ({
          firstName,
          lastName,
          email,
          phone,
          notes,
          moveInDate,
        })),
      });
      return (await res.json()) as { created: number; skipped: number };
    },
    onSuccess: ({ created, skipped }) => {
      onImported();
      setIsOpen(false);
      reset();
      toast({
        title: created === 1 ? "1 resident added" : `${created} residents added`,
        description: skipped > 0 ? `${skipped} row${skipped === 1 ? "" : "s"} skipped.` : undefined,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const onFileChosen = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    previewMutation.mutate(file);
  };

  const creatable = preview?.outcomes.filter((o) => o.kind === "create").map((o) => o.row) ?? [];
  const propertyLabel = properties.find((p) => p.id === propertyId)?.name ?? "";
  const busy = previewMutation.isPending || confirmMutation.isPending;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" data-testid="button-import-roster">
          <FileUp className="mr-2 h-4 w-4" /> Import from spreadsheet
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import a roster</DialogTitle>
          <DialogDescription>
            Upload a CSV and check what it found. Nothing is added until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="roster-property">House</Label>
            <Select
              value={propertyId}
              onValueChange={(value) => {
                setPropertyId(value);
                setPreview(null);
                setFileName(null);
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              <SelectTrigger id="roster-property" data-testid="select-import-property">
                <SelectValue placeholder="Choose a house" />
              </SelectTrigger>
              <SelectContent>
                {properties.map((property) => (
                  <SelectItem key={property.id} value={property.id}>
                    {property.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="roster-file">Spreadsheet</Label>
            <input
              ref={fileInput}
              id="roster-file"
              type="file"
              accept=".csv,text/csv"
              disabled={!propertyId || busy}
              onChange={(event) => onFileChosen(event.target.files?.[0])}
              data-testid="input-roster-file"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">
              A column each for first name, last name and email. Phone, move-in date and notes are optional.
            </p>
          </div>

          {previewMutation.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-import-reading">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading {fileName}…
            </p>
          )}

          {preview && preview.fileErrors.length > 0 && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              data-testid="text-import-file-errors"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {preview.fileErrors.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            </div>
          )}

          {preview && preview.outcomes.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm" data-testid="text-import-summary">
                <Badge className={OUTCOME_STYLES.create.className}>
                  {preview.counts.create} to add
                </Badge>
                {preview.counts.duplicate > 0 && (
                  <Badge className={OUTCOME_STYLES.duplicate.className}>
                    {preview.counts.duplicate} already on the roster
                  </Badge>
                )}
                {preview.counts.error > 0 && (
                  <Badge className={OUTCOME_STYLES.error.className}>
                    {preview.counts.error} need fixing
                  </Badge>
                )}
              </div>

              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left">
                    <tr>
                      <th className="p-2 font-medium">Row</th>
                      <th className="p-2 font-medium">Name</th>
                      <th className="p-2 font-medium">Email</th>
                      <th className="p-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.outcomes.map((outcome) => (
                      <tr
                        key={outcome.row.rowNumber}
                        className="border-t align-top"
                        data-testid={`row-import-${outcome.row.rowNumber}`}
                      >
                        <td className="p-2 text-muted-foreground">{outcome.row.rowNumber}</td>
                        <td className="p-2">
                          {`${outcome.row.firstName} ${outcome.row.lastName}`.trim() || "—"}
                        </td>
                        <td className="p-2 break-all">{outcome.row.email || "—"}</td>
                        <td className="p-2">
                          <Badge className={OUTCOME_STYLES[outcome.kind].className}>
                            {OUTCOME_STYLES[outcome.kind].label}
                          </Badge>
                          {outcome.reason && (
                            <p className="mt-1 text-xs text-muted-foreground">{outcome.reason}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.counts.error > 0 && (
                <p className="text-xs text-muted-foreground">
                  Rows that need fixing are skipped. Correct them in the spreadsheet and import it again —
                  the ones already added will be recognised and not duplicated.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setIsOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => confirmMutation.mutate(creatable)}
            disabled={busy || creatable.length === 0}
            data-testid="button-confirm-import"
          >
            {confirmMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            )}
            {creatable.length === 0
              ? "Nothing to add"
              : `Add ${creatable.length} to ${propertyLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
