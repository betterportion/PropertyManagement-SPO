import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bug, Lightbulb, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhotoUpload } from "@/components/PhotoUpload";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import { cn } from "@/lib/utils";
import type { FeedbackKind } from "@shared/schema";

const KINDS: { value: FeedbackKind; label: string; icon: typeof Bug; prompt: string }[] = [
  { value: "bug", label: "Something's not working", icon: Bug, prompt: "What happened? What did you expect?" },
  { value: "feature", label: "An idea", icon: Lightbulb, prompt: "What would make the portal easier for you?" },
];

/**
 * "Report a problem or idea", from the foot of the sidebar, for every account.
 * The server adds who sent it, their role, region and house; the page they
 * were on is sent from here.
 */
export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reset = () => { setKind("bug"); setMessage(""); setScreenshotUrl(null); setError(""); };

  const send = useMutation({
    mutationFn: () => apiRequest("POST", "/api/feedback", { kind, message, pagePath: window.location.pathname, screenshotUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feedback"] });
      toast({ title: "Thanks, we got it", description: "Your report went to the portal team." });
      reset();
      onOpenChange(false);
    },
    onError: (e) => setError(serverMessage(e) ?? "Your report was not sent. Try again."),
  });

  const prompt = KINDS.find((k) => k.value === kind)!.prompt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="dialog-feedback">
        <DialogHeader>
          <DialogTitle>Report a problem or idea</DialogTitle>
          <DialogDescription>It goes straight to the team building the portal.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (message.trim()) send.mutate(); else setError("Tell us what happened or what you'd like."); }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What kind of report">
            {KINDS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                onClick={() => setKind(value)}
                data-testid={`button-feedback-${value}`}
                className={cn(
                  "flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  kind === value ? "border-primary bg-primary/5 text-primary" : "border-border hover:bg-muted",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-message">{prompt}</Label>
            <Textarea
              id="feedback-message"
              rows={5}
              maxLength={4000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="input-feedback-message"
            />
          </div>

          <div className="space-y-2">
            <Label>Screenshot (optional)</Label>
            <PhotoUpload
              endpoint="/api/feedback-screenshots/upload"
              existingUrl={screenshotUrl ?? undefined}
              onUpload={(url) => { setScreenshotUrl(url); setError(""); }}
              onRemove={() => setScreenshotUrl(null)}
              onError={setError}
            />
          </div>

          <p className="text-xs text-muted-foreground">We'll also see which page you were on and your account, so we can follow up.</p>

          {error && <p className="text-sm text-destructive" role="alert" data-testid="text-feedback-error">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={send.isPending} data-testid="button-feedback-send">
              {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {send.isPending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
