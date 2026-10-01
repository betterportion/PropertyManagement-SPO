import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import type { Resident } from "@shared/schema";

interface PortalAccess {
  hasAccess: boolean;
  houseAccounts: Array<{ name: string; email: string | null }>;
  limit: number;
}

/**
 * Whether this resident can sign in to the portal. The portal is by
 * invitation: a household leader or steward gets in because their RA gave
 * them access here, and signs in with Google using the email on the roster.
 */
export default function PortalAccessCard({ resident, canManage }: { resident: Resident; canManage: boolean }) {
  const { toast } = useToast();
  const key = `/api/residents/${resident.id}/portal-access`;
  const { data } = useQuery<PortalAccess>({ queryKey: [key] });
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [key] });
    queryClient.invalidateQueries({ queryKey: ["/api/users"] });
  };
  const failed = (title: string) => (error: unknown) => toast({ title, description: serverMessage(error), variant: "destructive" });

  const grant = useMutation({
    mutationFn: async () => await apiRequest("POST", key),
    onSuccess: () => {
      refresh();
      toast({ title: "Access given", description: `${resident.firstName} can now sign in with Google using ${resident.email}.` });
    },
    onError: failed("Access not given"),
  });
  const remove = useMutation({
    mutationFn: async () => await apiRequest("DELETE", key),
    onSuccess: () => {
      refresh();
      toast({ title: "Access removed" });
    },
    onError: failed("Access not removed"),
  });

  if (!data) return null;
  const full = !data.hasAccess && data.houseAccounts.length >= data.limit;

  return (
    <Card data-testid="card-portal-access">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> Portal access
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          For the household leader and stewards: up to {data.limit} people per house. They sign in with Google using the email on
          the roster ({resident.email}).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {data.hasAccess ? (
            <Badge variant="success" data-testid="badge-portal-access">Has access</Badge>
          ) : (
            <Badge variant="outline" data-testid="badge-portal-access">No access</Badge>
          )}
          <span className="text-sm text-muted-foreground">
            {data.houseAccounts.length} of {data.limit} used at this house
            {data.houseAccounts.length > 0 ? `: ${data.houseAccounts.map((a) => a.name).join(", ")}` : ""}
          </span>
        </div>
        {canManage &&
          (data.hasAccess ? (
            <Button variant="secondary" onClick={() => setConfirmRemove(true)} disabled={remove.isPending} data-testid="button-remove-portal-access">
              Remove portal access
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => grant.mutate()}
              disabled={grant.isPending || full || !resident.isActive}
              data-testid="button-give-portal-access"
            >
              Give portal access
            </Button>
          ))}
        {canManage && full && (
          <p className="text-sm text-muted-foreground">This house already has {data.limit} people with access. Remove one first.</p>
        )}
      </CardContent>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {resident.firstName}'s portal access?</AlertDialogTitle>
            <AlertDialogDescription>
              They will no longer be able to sign in. Their roster record, requests and history stay as they are, and you can give
              access again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Remove access</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
