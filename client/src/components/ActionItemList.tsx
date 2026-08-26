import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCurrency, formatDate } from "@/lib/format";
import { type ActionItem, categoryLabel, resolveRequest, type ResolveRequest } from "@/lib/actionItems";

/**
 * The dashboard's and Tasks page's shared list of action items. Each row shows
 * what needs doing and a single Resolve button; money items confirm first. The
 * component owns the resolve mutation and its confirm dialog so both callers
 * render an identical, accessible row.
 */
export default function ActionItemList({ items }: { items: ActionItem[] }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [pending, setPending] = useState<{ item: ActionItem; request: ResolveRequest } | null>(null);

  const resolveMutation = useMutation({
    mutationFn: async (request: ResolveRequest) => apiRequest(request.method!, request.path!, request.body),
    onSuccess: (_data, request) => {
      for (const key of request.invalidate ?? []) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast({ title: "Done" });
    },
    onError: () =>
      toast({ title: "Could not resolve", description: "Please try again, or open the record directly.", variant: "destructive" }),
  });

  const onResolve = (item: ActionItem) => {
    const request = resolveRequest(item);
    if (request.href) {
      setLocation(request.href);
    } else if (request.confirm) {
      setPending({ item, request });
    } else {
      resolveMutation.mutate(request);
    }
  };

  return (
    <>
      <div className="space-y-3">
        {items.map((item) => {
          const request = resolveRequest(item);
          return (
            <div
              key={`${item.source}-${item.id}`}
              className="flex items-start justify-between gap-3 rounded-md bg-muted p-3"
              data-testid={`action-item-${item.source}-${item.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{categoryLabel(item)}</Badge>
                  <p className="truncate text-sm font-medium">{item.title}</p>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {item.subtitle}
                  {item.amount != null ? ` · ${formatCurrency(item.amount)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onResolve(item)}
                  disabled={resolveMutation.isPending}
                  data-testid={`button-resolve-${item.source}-${item.id}`}
                >
                  {request.actionLabel}
                </Button>
                {item.dueDate && (
                  <span className={`text-xs ${item.overdue ? "text-destructive" : "text-muted-foreground"}`}>
                    {item.overdue ? "Overdue" : "Due"} {formatDate(item.dueDate)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.request.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.request.confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) resolveMutation.mutate(pending.request);
                setPending(null);
              }}
            >
              {pending?.request.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
