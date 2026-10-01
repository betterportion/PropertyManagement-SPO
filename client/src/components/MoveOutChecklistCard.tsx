import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Trash2 } from "lucide-react";

import { PhotoUpload } from "@/components/PhotoUpload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/format";
import { serverMessage } from "@/lib/serverMessage";
import type { MoveOutChecklist, MoveOutPhoto, Resident } from "@shared/schema";

interface ChecklistResponse {
  checklist: MoveOutChecklist | null;
  photos: MoveOutPhoto[];
}

type Fields = Pick<MoveOutChecklist, "roomInspected" | "damageNotes" | "belongingsRemoved" | "keysReturned" | "notes">;

const CHECKS: Array<{ key: "roomInspected" | "belongingsRemoved" | "keysReturned"; label: string; hint: string }> = [
  { key: "roomInspected", label: "Room inspected for damage", hint: "Holes in walls, broken fixtures, stains." },
  { key: "belongingsRemoved", label: "All belongings removed", hint: "Anything left means a junk-removal bill." },
  { key: "keysReturned", label: "Keys returned", hint: "Every key, fob and garage opener." },
];

/**
 * The RA's move-out checklist for one resident, completed in the portal.
 * Completing it records who and when. Staff only; editing takes the property
 * permission, like the rest of the roster.
 */
export default function MoveOutChecklistCard({ resident, canManage }: { resident: Resident; canManage: boolean }) {
  const { toast } = useToast();
  const key = `/api/residents/${resident.id}/move-out-checklist`;
  const { data } = useQuery<ChecklistResponse>({ queryKey: [key] });
  const [draft, setDraft] = useState<Fields | null>(null);

  const saved: Fields = {
    roomInspected: data?.checklist?.roomInspected ?? false,
    damageNotes: data?.checklist?.damageNotes ?? null,
    belongingsRemoved: data?.checklist?.belongingsRemoved ?? false,
    keysReturned: data?.checklist?.keysReturned ?? false,
    notes: data?.checklist?.notes ?? null,
  };
  const fields = draft ?? saved;
  const allTicked = fields.roomInspected && fields.belongingsRemoved && fields.keysReturned;
  const completedAt = data?.checklist?.completedAt ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: [key] });

  const save = useMutation({
    mutationFn: async (complete: boolean) => await apiRequest("PUT", key, { ...fields, complete }),
    onSuccess: (_res, complete) => {
      setDraft(null);
      refresh();
      toast({ title: complete ? "Move-out complete" : "Saved" });
    },
    onError: (error) => toast({ title: "That did not save", description: serverMessage(error), variant: "destructive" }),
  });

  const addPhoto = useMutation({
    mutationFn: async (imageUrl: string) => await apiRequest("POST", `/api/residents/${resident.id}/move-out-photos`, { imageUrl }),
    onSuccess: refresh,
    onError: (error) => toast({ title: "The photo was not added", description: serverMessage(error), variant: "destructive" }),
  });

  const removePhoto = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/move-out-photos/${id}`),
    onSuccess: refresh,
    onError: (error) => toast({ title: "The photo was not removed", description: serverMessage(error), variant: "destructive" }),
  });

  const set = (patch: Partial<Fields>) => setDraft({ ...fields, ...patch });

  return (
    <Card data-testid="card-move-out-checklist">
      <CardHeader>
        <CardTitle>Move-out checklist</CardTitle>
        {completedAt ? (
          <p className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400" data-testid="text-move-out-complete">
            <CheckCircle2 className="h-4 w-4" />
            Completed {formatDateTime(completedAt)}
            {data?.checklist?.completedByEmail ? ` by ${data.checklist.completedByEmail}` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Done by the regional administrator when {resident.firstName} leaves.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {CHECKS.map((check) => (
            <div key={check.key} className="flex items-start gap-2">
              <Checkbox
                id={`move-out-${check.key}`}
                checked={fields[check.key]}
                disabled={!canManage}
                onCheckedChange={(checked) => set({ [check.key]: !!checked })}
                data-testid={`checkbox-move-out-${check.key}`}
              />
              <Label htmlFor={`move-out-${check.key}`} className="cursor-pointer leading-tight">
                {check.label}
                <span className="block text-xs font-normal text-muted-foreground">{check.hint}</span>
              </Label>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="move-out-damage">Damage found</Label>
          <Textarea
            id="move-out-damage"
            rows={2}
            maxLength={2000}
            disabled={!canManage}
            value={fields.damageNotes ?? ""}
            placeholder="e.g. two holes in the wall by the desk"
            onChange={(e) => set({ damageNotes: e.target.value })}
            data-testid="textarea-move-out-damage"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="move-out-notes">Notes</Label>
          <Textarea
            id="move-out-notes"
            rows={2}
            maxLength={2000}
            disabled={!canManage}
            value={fields.notes ?? ""}
            onChange={(e) => set({ notes: e.target.value })}
            data-testid="textarea-move-out-notes"
          />
        </div>

        <div className="space-y-2">
          <Label>Photos (optional)</Label>
          {(data?.photos ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data!.photos.map((photo) => (
                <div key={photo.id} className="relative">
                  <img src={photo.imageUrl} alt="Move-out" className="h-24 w-24 rounded-md border object-cover" />
                  {canManage && (
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute right-1 top-1 h-6 w-6"
                      aria-label="Remove photo"
                      onClick={() => removePhoto.mutate(photo.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canManage && (
            <PhotoUpload
              onUpload={(url) => addPhoto.mutate(url)}
              onError={(message) => toast({ title: "Upload failed", description: message, variant: "destructive" })}
            />
          )}
        </div>

        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => save.mutate(false)} disabled={save.isPending || !draft} data-testid="button-move-out-save">
              Save
            </Button>
            {!completedAt && (
              <Button variant="primary" onClick={() => save.mutate(true)} disabled={save.isPending || !allTicked} data-testid="button-move-out-complete">
                Mark move-out complete
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
