import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, Unlink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/format";
import { serverMessage } from "@/lib/serverMessage";
import { isQuickBooksStale, QUICKBOOKS_STALE_AFTER_HOURS, type QuickBooksHealth } from "@shared/quickbooks";
import type { Property, PropertyQuickbooksLink } from "@shared/schema";

interface QuickBooksStatus extends QuickBooksHealth {
  companyName: string | null;
  connectedByEmail: string | null;
  repairAccountIds: string[];
  lastAttemptAt: string | null;
  lastErrorAt: string | null;
}

interface ListItem {
  id: string;
  name: string;
  type?: string;
}

type SyncResult = { ok: true; housesUpdated: number; ownedNotLinked: number } | { ok: false; message: string };

const STATUS_KEY = "/api/quickbooks/status";
const LINKS_KEY = "/api/quickbooks/links";

/**
 * Connecting SPO's QuickBooks company, and telling the portal how to read it.
 *
 * Admins only. Three things to set, in order: connect, choose which expense
 * accounts count as repair & maintenance, and link each owned house to its
 * QuickBooks class. The daily sync does the rest; "Sync now" is for after a
 * change. The portal only ever reads QuickBooks.
 */
export default function QuickBooksSettings() {
  const { toast } = useToast();

  const { data: status, isLoading } = useQuery<QuickBooksStatus>({ queryKey: [STATUS_KEY] });
  const connected = !!status?.configured && !!status.connected;

  const accountsQuery = useQuery<ListItem[]>({ queryKey: ["/api/quickbooks/accounts"], enabled: connected });
  const classesQuery = useQuery<ListItem[]>({ queryKey: ["/api/quickbooks/classes"], enabled: connected });
  const { data: links = [] } = useQuery<PropertyQuickbooksLink[]>({ queryKey: [LINKS_KEY], enabled: connected });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"], enabled: connected });

  const [chosenAccounts, setChosenAccounts] = useState<string[] | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const accountSelection = chosenAccounts ?? status?.repairAccountIds ?? [];

  // Back from Intuit: say how it went, once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("quickbooks");
    if (!outcome) return;
    if (outcome === "connected") toast({ title: "QuickBooks connected" });
    else if (outcome === "cancelled") toast({ title: "QuickBooks was not connected", description: "The sign-in was cancelled." });
    else toast({ title: "QuickBooks did not connect", description: "Try again. If it keeps failing, check the QuickBooks settings on the server.", variant: "destructive" });
    params.delete("quickbooks");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  }, [toast]);

  const refreshAll = () => {
    for (const key of [STATUS_KEY, LINKS_KEY, "/api/property-spend", "/api/action-items", "/api/quickbooks/accounts", "/api/quickbooks/classes"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  const failed = (title: string) => (error: unknown) => toast({ title, description: serverMessage(error), variant: "destructive" });

  const connect = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", "/api/quickbooks/connect")).json()) as { url: string },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: failed("Could not start connecting QuickBooks"),
  });

  const disconnect = useMutation({
    mutationFn: async () => await apiRequest("POST", "/api/quickbooks/disconnect"),
    onSuccess: () => {
      refreshAll();
      toast({ title: "QuickBooks disconnected" });
    },
    onError: failed("Could not disconnect QuickBooks"),
  });

  const sync = useMutation({
    mutationFn: async () => (await (await apiRequest("POST", "/api/quickbooks/sync")).json()) as SyncResult,
    onSuccess: (result) => {
      refreshAll();
      if (result.ok) {
        toast({
          title: "Spend updated",
          description:
            `${result.housesUpdated} house${result.housesUpdated === 1 ? "" : "s"} updated` +
            (result.ownedNotLinked > 0 ? `; ${result.ownedNotLinked} owned not linked yet.` : "."),
        });
      } else {
        toast({ title: "The sync did not finish", description: result.message, variant: "destructive" });
      }
    },
    onError: failed("The sync did not run"),
  });

  const saveAccounts = useMutation({
    mutationFn: async () => await apiRequest("PUT", "/api/quickbooks/accounts", { accountIds: accountSelection }),
    onSuccess: () => {
      setChosenAccounts(null);
      refreshAll();
      toast({ title: "Accounts saved", description: "Sync now to update the spend with them." });
    },
    onError: failed("Accounts not saved"),
  });

  const link = useMutation({
    mutationFn: async ({ propertyId, classId }: { propertyId: string; classId: string | null }) =>
      classId
        ? await apiRequest("PUT", `/api/properties/${propertyId}/quickbooks-link`, { classId })
        : await apiRequest("DELETE", `/api/properties/${propertyId}/quickbooks-link`),
    onSuccess: () => refreshAll(),
    onError: failed("The link was not saved"),
  });

  const ownedHouses = useMemo(
    () => properties.filter((p) => p.ownership === "owned").sort((a, b) => a.name.localeCompare(b.name)),
    [properties],
  );
  const linkByProperty = useMemo(() => new Map(links.map((l) => [l.propertyId, l])), [links]);
  const accountsChanged =
    chosenAccounts !== null && [...chosenAccounts].sort().join() !== [...(status?.repairAccountIds ?? [])].sort().join();
  const stale = connected && isQuickBooksStale(status?.lastSuccessAt ?? status?.connectedAt, new Date());

  return (
    <Card id="quickbooks" data-testid="card-quickbooks">
      <CardHeader>
        <CardTitle>QuickBooks</CardTitle>
        <p className="text-sm text-muted-foreground">
          Reads each owned house's repair &amp; maintenance spend once a day. The portal never changes anything in QuickBooks.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <LoadingState />
        ) : !status?.configured ? (
          <p className="text-sm text-muted-foreground" data-testid="text-quickbooks-not-configured">
            QuickBooks isn't set up on this server yet. Whoever manages the server adds the four QUICKBOOKS_ settings
            (see docs/WORKFLOWS.md), and then you can connect here.
          </p>
        ) : !status.connected ? (
          <div className="space-y-3">
            <p className="text-sm" data-testid="text-quickbooks-disconnected">
              {status.lost
                ? "QuickBooks stopped accepting the connection, so spend is no longer updating. Connect it again to carry on."
                : "Not connected. A QuickBooks admin signs in once, and the portal reads from then on."}
            </p>
            {status.lastError && <p className="text-sm text-destructive">{status.lastError}</p>}
            <Button variant="primary" onClick={() => connect.mutate()} disabled={connect.isPending} data-testid="button-quickbooks-connect">
              {connect.isPending ? "Opening QuickBooks…" : "Connect QuickBooks"}
            </Button>
          </div>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Company</dt>
                <dd className="mt-0.5 font-medium" data-testid="text-quickbooks-company">{status.companyName}</dd>
                <dd className="text-xs text-muted-foreground">
                  Connected {formatDateTime(status.connectedAt)}
                  {status.connectedByEmail ? ` by ${status.connectedByEmail}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last successful sync</dt>
                <dd className="mt-0.5 font-medium" data-testid="text-quickbooks-last-sync">
                  {status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : "Not yet"}
                </dd>
                {stale && (
                  <dd className="text-xs text-destructive">No good sync in over {QUICKBOOKS_STALE_AFTER_HOURS} hours</dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last error</dt>
                <dd className="mt-0.5 text-sm" data-testid="text-quickbooks-last-error">
                  {status.lastError ? (
                    <span className="text-destructive">
                      {status.lastError} <span className="text-muted-foreground">({formatDateTime(status.lastErrorAt)})</span>
                    </span>
                  ) : (
                    "None"
                  )}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="button-quickbooks-sync">
                <RefreshCw className="mr-1 h-4 w-4" />
                {sync.isPending ? "Syncing…" : "Sync now"}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDisconnect(true)} data-testid="button-quickbooks-disconnect">
                Disconnect
              </Button>
            </div>

            <section className="space-y-3">
              <div>
                <h3 className="font-medium">Repair &amp; maintenance accounts</h3>
                <p className="text-sm text-muted-foreground">
                  Spending on the accounts ticked here counts against each house's budget. Ticking a parent account includes its sub-accounts.
                </p>
              </div>
              {accountsQuery.isLoading ? (
                <LoadingState />
              ) : accountsQuery.isError ? (
                <p className="text-sm text-destructive">{serverMessage(accountsQuery.error) ?? "Could not load the accounts."}</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {(accountsQuery.data ?? []).map((account) => (
                    <div key={account.id} className="flex items-center gap-2 rounded-md border p-2">
                      <Checkbox
                        id={`qb-account-${account.id}`}
                        checked={accountSelection.includes(account.id)}
                        onCheckedChange={(checked) =>
                          setChosenAccounts(
                            checked ? [...accountSelection, account.id] : accountSelection.filter((id) => id !== account.id),
                          )
                        }
                        data-testid={`checkbox-qb-account-${account.id}`}
                      />
                      <Label htmlFor={`qb-account-${account.id}`} className="flex-1 cursor-pointer">
                        {account.name} <span className="text-xs text-muted-foreground">{account.type}</span>
                      </Label>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="secondary"
                disabled={!accountsChanged || saveAccounts.isPending}
                onClick={() => saveAccounts.mutate()}
                data-testid="button-quickbooks-save-accounts"
              >
                Save accounts
              </Button>
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="font-medium">Houses</h3>
                <p className="text-sm text-muted-foreground">Link each owned house to the QuickBooks class its repairs are tagged with.</p>
              </div>
              {classesQuery.isError && (
                <p className="text-sm text-destructive">{serverMessage(classesQuery.error) ?? "Could not load the classes."}</p>
              )}
              <ul className="divide-y divide-border rounded-md border border-border">
                {ownedHouses.map((house) => {
                  const current = linkByProperty.get(house.id);
                  return (
                    <li key={house.id} className="flex flex-wrap items-center justify-between gap-3 p-3" data-testid={`row-qb-house-${house.id}`}>
                      <div>
                        <p className="font-medium">{house.name}</p>
                        <p className="text-xs text-muted-foreground">{house.region}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!current && <Badge variant="outline">Not linked to QuickBooks</Badge>}
                        <Select
                          value={current?.externalId ?? ""}
                          onValueChange={(classId) => link.mutate({ propertyId: house.id, classId })}
                          disabled={link.isPending || !classesQuery.data}
                        >
                          <SelectTrigger className="w-56" data-testid={`select-qb-class-${house.id}`}>
                            <SelectValue placeholder="Choose a class" />
                          </SelectTrigger>
                          <SelectContent>
                            {/* A link whose class was since removed in QuickBooks still shows its name. */}
                            {current && !classesQuery.data?.some((c) => c.id === current.externalId) && (
                              <SelectItem value={current.externalId}>{current.externalName}</SelectItem>
                            )}
                            {(classesQuery.data ?? []).map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {current && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Unlink ${house.name}`}
                            onClick={() => link.mutate({ propertyId: house.id, classId: null })}
                            data-testid={`button-qb-unlink-${house.id}`}
                          >
                            <Unlink className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect QuickBooks?</AlertDialogTitle>
            <AlertDialogDescription>
              Spend stops updating until somebody connects it again. The figures already read, the house links and the chosen accounts are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => disconnect.mutate()}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
