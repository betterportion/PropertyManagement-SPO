import { useRef, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The one file a comment may carry, between choosing it and posting.
 *
 * The file goes up the moment it is chosen, through the request's own
 * attachment route, and what comes back -- where it went and what it was
 * called -- is held here until Post. Removing it before posting forgets the
 * pair; the file itself stays in storage, as it does after a delete (known
 * issue 1). A second file is a second comment, so there is one slot.
 */

export interface PendingAttachment {
  url: string;
  name: string;
}

// The same set the document upload route accepts, spelled the way a file
// picker wants it. The server checks the real bytes; this only keeps the
// picker from offering a spreadsheet.
const ACCEPT = ".pdf,.doc,.docx,image/jpeg,image/png,image/gif,image/webp";
const MAX_BYTES = 20 * 1024 * 1024;

interface CommentAttachmentFieldProps {
  requestId: string;
  value: PendingAttachment | null;
  onChange: (value: PendingAttachment | null) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

export function CommentAttachmentField({ requestId, value, onChange, onError, disabled }: CommentAttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      onError("Files must be smaller than 20MB.");
      return;
    }
    setIsUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/maintenance-requests/${requestId}/attachments`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "The file could not be uploaded.");
      }
      const data = await response.json();
      if (typeof data.url !== "string" || typeof data.name !== "string") {
        throw new Error("The server did not say where the file went.");
      }
      onChange({ url: data.url, name: data.name });
    } catch (error) {
      onError(error instanceof Error ? error.message : "The file could not be uploaded.");
    } finally {
      setIsUploading(false);
      // So choosing the same file again after a failure still fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled || isUploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
        data-testid="input-comment-attachment"
      />
      {value ? (
        <>
          <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate" data-testid="text-pending-attachment">
            {value.name}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
            data-testid="button-remove-attachment"
          >
            <X className="h-3.5 w-3.5" />
            Remove
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || isUploading}
            onClick={() => inputRef.current?.click()}
            data-testid="button-attach-file"
          >
            {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            {isUploading ? "Uploading..." : "Attach a file"}
          </Button>
          <span className="text-xs text-muted-foreground">One file per comment. PDF, Word or an image, up to 20MB.</span>
        </>
      )}
    </div>
  );
}
