import { useState } from "react";
import { Pin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * A staff note that follows a room or an item from one walkthrough to the
 * next: "floor has a crack by the window, photograph it each year".
 *
 * Shown to whoever is doing the capture, leaders included, because it is
 * instruction for them. Edited by staff only; the server refuses a resident
 * writing one. Distinct from the walkthrough's own notes, which belong to one
 * dated visit -- this one is copied onto next year's walkthrough by
 * planFromPreviousWalkthrough and stays until somebody clears it.
 */
export default function StandingNote({
  value,
  canEdit,
  onSave,
  testId,
}: {
  value: string | null | undefined;
  canEdit: boolean;
  onSave: (value: string | null) => void;
  testId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!value && !canEdit) return null;

  if (editing) {
    return (
      <div className="space-y-2" data-testid={`${testId}-editor`}>
        <Textarea
          value={draft}
          rows={2}
          maxLength={500}
          placeholder="e.g. Crack by the window — photograph it every year."
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Standing note"
          data-testid={`${testId}-input`}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onSave(draft.trim() || null);
              setEditing(false);
            }}
            data-testid={`${testId}-save`}
          >
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (!value) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
        data-testid={`${testId}-add`}
      >
        <Pin className="h-3.5 w-3.5" /> Add a standing note
      </Button>
    );
  }

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950"
      data-testid={testId}
    >
      <Pin className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Every visit: </span>
        {value}
      </p>
      {canEdit && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          data-testid={`${testId}-edit`}
        >
          Edit
        </Button>
      )}
    </div>
  );
}
