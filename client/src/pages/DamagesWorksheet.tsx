import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { AccessDeniedState, EmptyState, LoadingState } from "@/components/states";
import DepositStatement from "@/components/deposit/DepositStatement";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, formatDate } from "@/lib/format";
import { CONDITION_LABEL } from "@/lib/walkthrough";
import { fromCents, runningBalance, splitEvenly, toCents } from "@shared/depositLedger";
import { residentsActiveOn } from "@shared/residents";
import {
  WALKTHROUGH_FLAGGED_CONDITIONS,
  foldName,
  type DepositDeduction,
  type Resident,
  type SecurityDeposit,
  type Walkthrough,
  type WalkthroughItem,
  type WalkthroughRoom,
} from "@shared/schema";

/**
 * Move-out damages: from the walkthrough to each person's deposit.
 *
 * The piece finance actually uses, and where the money rules apply without
 * exception: amounts, dates, descriptions and statuses only, never a banking
 * identifier, every deduction recorded through the routes that already audit
 * them. This screen writes nothing of its own -- each row is saved through
 * the single-deduction route or the split route, so the arithmetic, the
 * per-person rows and the audit events are the ones that already exist.
 *
 *   - Every item recorded poor or damaged is listed, and stays listed at
 *     zero if the RA decides not to charge: that is the record that it was
 *     considered.
 *   - A row defaults to the room's occupants (residents whose room folds to
 *     the item's room) and otherwise to the whole house on the walkthrough
 *     date, with a manual override.
 *   - The split is shown, editable, before anything is saved, from the same
 *     `splitEvenly` the server runs.
 *
 * Staff only. A resident never sees deposit data anywhere in the portal.
 */

const FLAGGED = new Set<string>(WALKTHROUGH_FLAGGED_CONDITIONS);
const today = () => new Date().toISOString().slice(0, 10);

interface RowState {
  amount: string;
  residentIds: string[];
}

export default function DamagesWorksheet() {
  const params = useParams<{ id: string }>();
  const walkthroughId = params.id;
  const { user } = useAuth();
  const { toast } = useToast();

  const walkthroughQuery = useQuery<Walkthrough>({ queryKey: ["/api/walkthroughs", walkthroughId], enabled: !!walkthroughId, retry: false });
  const roomsQuery = useQuery<WalkthroughRoom[]>({ queryKey: ["/api/walkthroughs", walkthroughId, "rooms"], enabled: !!walkthroughId });
  const itemsQuery = useQuery<WalkthroughItem[]>({ queryKey: ["/api/walkthroughs", walkthroughId, "items"], enabled: !!walkthroughId });
  const residentsQuery = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  const depositsQuery = useQuery<SecurityDeposit[]>({ queryKey: ["/api/security-deposits"], retry: false });
  const deductionsQuery = useQuery<DepositDeduction[]>({ queryKey: ["/api/deposit-deductions"], retry: false });

  const [overrides, setOverrides] = useState<Record<string, Partial<RowState>>>({});
  const [reference, setReference] = useState<Record<string, string>>({});
  const [statementFor, setStatementFor] = useState<Resident | null>(null);

  // Computed below every hook, never returned on above one.
  const typedUser = user as { role?: string; permissions?: Record<string, boolean> } | null;
  const isAdmin = typedUser?.role === "admin";
  const isStaff = isAdmin || typedUser?.role === "regional_administrator";
  const canManageFinance = isAdmin || typedUser?.permissions?.canManageFinancials === true;

  const walkthrough = walkthroughQuery.data;
  const deposits = depositsQuery.data ?? [];
  const deductions = deductionsQuery.data ?? [];

  const houseResidents = useMemo(
    () => (residentsQuery.data ?? []).filter((resident) => resident.propertyId === walkthrough?.propertyId),
    [residentsQuery.data, walkthrough?.propertyId],
  );
  const activeResidents = useMemo(
    () => residentsActiveOn(houseResidents, walkthrough?.walkthroughDate),
    [houseResidents, walkthrough?.walkthroughDate],
  );

  /** The flagged, undismissed items with their room, in walking order. */
  const rows = useMemo(() => {
    const rooms = roomsQuery.data ?? [];
    const items = itemsQuery.data ?? [];
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    return items
      .filter((item) => FLAGGED.has(item.condition) && !item.dismissedAt)
      .map((item) => ({ item, room: roomById.get(item.roomId) }))
      .filter((row): row is { item: WalkthroughItem; room: WalkthroughRoom } => !!row.room)
      .sort((a, b) => a.room.displayOrder - b.room.displayOrder || a.item.displayOrder - b.item.displayOrder);
  }, [itemsQuery.data, roomsQuery.data]);

  /** Who a row charges by default: the room's occupants, else the house. */
  const defaultResidentsFor = (room: WalkthroughRoom): string[] => {
    const occupants = activeResidents.filter((resident) => resident.roomName && foldName(resident.roomName) === foldName(room.name));
    return (occupants.length > 0 ? occupants : activeResidents).map((resident) => resident.id);
  };
  const stateFor = (item: WalkthroughItem, room: WalkthroughRoom): RowState => ({
    amount: overrides[item.id]?.amount ?? "",
    residentIds: overrides[item.id]?.residentIds ?? defaultResidentsFor(room),
  });
  const alreadyCharged = (itemId: string) => deductions.filter((deduction) => deduction.walkthroughItemId === itemId);

  const save = useMutation({
    mutationFn: async () => {
      if (!walkthrough) return { saved: 0, failed: 0, attempted: 0 };
      const chargeDate = new Date(walkthrough.walkthroughDate).toISOString().slice(0, 10);
      let saved = 0;
      let failed = 0;
      let attempted = 0;
      for (const { item, room } of rows) {
        if (alreadyCharged(item.id).length > 0) continue;
        const state = stateFor(item, room);
        const cents = toCents(state.amount);
        if (cents <= 0 || state.residentIds.length === 0) continue;
        attempted += 1;
        const description = `${room.name} — ${item.label}${item.notes ? ` (${item.notes.trim()})` : ""}`;
        try {
          if (state.residentIds.length === 1) {
            await apiRequest("POST", "/api/deposit-deductions", {
              residentId: state.residentIds[0],
              description,
              amount: Number(state.amount),
              chargeDate,
              walkthroughItemId: item.id,
            });
          } else {
            await apiRequest("POST", "/api/deposit-deductions/split", {
              propertyId: walkthrough.propertyId,
              description,
              amount: Number(state.amount),
              chargeDate,
              residentIds: state.residentIds,
              walkthroughItemId: item.id,
            });
          }
          saved += 1;
        } catch {
          failed += 1;
        }
      }
      return { saved, failed, attempted };
    },
    onSuccess: ({ saved, failed, attempted }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deposit-deductions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      if (attempted === 0) {
        toast({ title: "Nothing to save", description: "Enter an amount on at least one row." });
      } else if (failed === 0) {
        toast({ title: `Saved ${saved} charge${saved === 1 ? "" : "s"}`, description: "Each person's line is on their deposit ledger." });
      } else {
        toast({ title: `Saved ${saved} of ${attempted}`, description: `${failed} row${failed === 1 ? "" : "s"} did not save. The rest are recorded; try those again.`, variant: "destructive" });
      }
    },
  });

  const closeOut = useMutation({
    mutationFn: async ({ deposit, body }: { deposit: SecurityDeposit; body: Record<string, unknown> }) =>
      await apiRequest("PATCH", `/api/security-deposits/${deposit.id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/security-deposits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
    },
    onError: () => toast({ title: "That did not save", variant: "destructive" }),
  });

  let body: React.ReactNode;
  if (!isStaff) {
    body = <AccessDeniedState />;
  } else if (walkthroughQuery.isLoading || roomsQuery.isLoading || itemsQuery.isLoading) {
    body = <LoadingState message="Loading the walkthrough..." />;
  } else if (!walkthrough) {
    body = <EmptyState title="This walkthrough could not be opened" description="It may have been deleted, or it belongs to a region you do not cover." />;
  } else if (walkthrough.type !== "move_out") {
    body = <EmptyState title="Damages are charged from a move-out walkthrough" description="This one is not a move-out, so there is nothing to charge from it." />;
  } else if (walkthrough.status === "draft") {
    body = (
      <EmptyState
        title="Mark it submitted first"
        description="The worksheet opens once the walkthrough has been submitted, so the charges are built from a finished walk rather than a half-done one."
        action={
          <Button variant="secondary" asChild>
            <Link href={`/walkthroughs/${walkthrough.id}`} data-testid="link-back-to-walkthrough">Open the walkthrough</Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <Card>
          <CardHeader>
            <CardTitle>What was found</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-damage">
                Nothing on this walkthrough was recorded poor or damaged.
              </p>
            ) : (
              <ul className="space-y-4">
                {rows.map(({ item, room }) => {
                  const charged = alreadyCharged(item.id);
                  const state = stateFor(item, room);
                  const shares = splitEvenly(toCents(state.amount), state.residentIds.length);
                  return (
                    <li key={item.id} className="rounded-md border border-border p-4" data-testid={`row-damage-${item.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={item.condition === "damaged" ? "destructive" : "warning"}>{CONDITION_LABEL[item.condition]}</Badge>
                        <p className="font-medium">
                          {room.name} · {item.label}
                        </p>
                        <Link href={`/walkthroughs/${walkthrough.id}?room=${room.id}`} className="text-sm underline underline-offset-2">
                          Open in the walkthrough
                        </Link>
                      </div>
                      {item.notes && <p className="mt-1 text-sm text-muted-foreground">{item.notes}</p>}

                      {charged.length > 0 ? (
                        <p className="mt-3 text-sm" data-testid={`text-charged-${item.id}`}>
                          Already charged: {formatCurrency(fromCents(charged.reduce((sum, d) => sum + toCents(d.amount), 0)))} across{" "}
                          {charged.length} {charged.length === 1 ? "person" : "people"}.
                        </p>
                      ) : (
                        <div className="mt-3 grid gap-4 sm:grid-cols-[10rem_1fr]">
                          <div className="space-y-2">
                            <Label htmlFor={`amount-${item.id}`}>Charge ($)</Label>
                            <Input
                              id={`amount-${item.id}`}
                              type="number"
                              min={0}
                              step="0.01"
                              value={state.amount}
                              placeholder="0.00"
                              disabled={!canManageFinance}
                              onChange={(event) => setOverrides((current) => ({ ...current, [item.id]: { ...current[item.id], amount: event.target.value } }))}
                              data-testid={`input-damage-amount-${item.id}`}
                            />
                            <p className="text-xs text-muted-foreground">Leave at zero to charge nobody; the row stays as the record it was considered.</p>
                          </div>
                          <div className="space-y-2">
                            <Label>Who pays</Label>
                            <ul className="divide-y divide-border rounded-md border border-border">
                              {activeResidents.map((resident) => {
                                const index = state.residentIds.indexOf(resident.id);
                                return (
                                  <li key={resident.id} className="flex items-center gap-3 p-2 text-sm">
                                    <Checkbox
                                      checked={index >= 0}
                                      disabled={!canManageFinance}
                                      aria-label={`Charge ${resident.firstName} ${resident.lastName}`}
                                      onCheckedChange={(checked) =>
                                        setOverrides((current) => {
                                          const ids = new Set(stateFor(item, room).residentIds);
                                          if (checked) ids.add(resident.id);
                                          else ids.delete(resident.id);
                                          return { ...current, [item.id]: { ...current[item.id], residentIds: Array.from(ids) } };
                                        })
                                      }
                                      data-testid={`checkbox-damage-${item.id}-${resident.id}`}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {resident.firstName} {resident.lastName}
                                      {resident.roomName && <span className="text-muted-foreground"> · {resident.roomName}</span>}
                                    </span>
                                    <span className="tabular-nums" data-testid={`text-damage-share-${item.id}-${resident.id}`}>
                                      {index >= 0 && toCents(state.amount) > 0 ? formatCurrency(fromCents(shares[index])) : "—"}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                            <p className="text-xs text-muted-foreground">
                              {state.residentIds.length > 1
                                ? "Split evenly, the remainder a cent at a time from the top. Each person gets their own line."
                                : "One person's line."}
                            </p>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {rows.length > 0 && canManageFinance && (
              <div className="flex justify-end">
                <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()} data-testid="button-save-damages">
                  {save.isPending ? "Saving…" : "Record the charges"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Close-out</CardTitle>
          </CardHeader>
          <CardContent>
            {activeResidents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody on the roster was living here on the walkthrough date.</p>
            ) : (
              <ul className="divide-y divide-border">
                {activeResidents.map((resident) => {
                  const deposit = deposits.find((d) => d.residentId === resident.id);
                  const theirs = deductions.filter((d) => d.residentId === resident.id);
                  const balance = deposit ? runningBalance(deposit.amountHeld, theirs) : null;
                  const returned = deposit?.status === "returned";
                  return (
                    <li key={resident.id} className="flex flex-wrap items-center gap-3 py-3" data-testid={`row-closeout-${resident.id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {resident.firstName} {resident.lastName}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {deposit
                            ? `Held ${formatCurrency(deposit.amountHeld)} · balance ${formatCurrency(fromCents(balance ?? 0))}`
                            : "No deposit recorded"}
                          {deposit?.statementProvidedOn ? ` · statement ${formatDate(deposit.statementProvidedOn)}` : ""}
                        </p>
                      </div>
                      {deposit && (
                        <>
                          <Badge variant={returned ? "outline" : "secondary"}>{deposit.status.replace("_", " ")}</Badge>
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={returned}
                              disabled={!canManageFinance || returned || (balance ?? 0) < 0 || closeOut.isPending}
                              onCheckedChange={(checked) =>
                                checked &&
                                closeOut.mutate({
                                  deposit,
                                  body: { status: "returned", amountReturned: fromCents(Math.max(balance ?? 0, 0)), returnedDate: today() },
                                })
                              }
                              data-testid={`checkbox-returned-${resident.id}`}
                            />
                            Returned
                          </label>
                          <Input
                            className="w-40"
                            placeholder="QuickBooks/Ramp ref"
                            value={reference[resident.id] ?? deposit.closeoutReference ?? ""}
                            disabled={!canManageFinance}
                            onChange={(event) => setReference((current) => ({ ...current, [resident.id]: event.target.value }))}
                            onBlur={() => {
                              const value = (reference[resident.id] ?? "").trim();
                              if (value && value !== (deposit.closeoutReference ?? "")) closeOut.mutate({ deposit, body: { closeoutReference: value } });
                            }}
                            aria-label={`Processor reference for ${resident.firstName} ${resident.lastName}`}
                            data-testid={`input-closeout-ref-${resident.id}`}
                          />
                          <Button variant="secondary" size="sm" onClick={() => setStatementFor(resident)} data-testid={`button-statement-${resident.id}`}>
                            <FileText className="h-4 w-4" />
                            Statement
                          </Button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {(balanceShortfall(activeResidents, deposits, deductions)) && (
              <p className="mt-3 text-sm text-destructive" data-testid="text-closeout-shortfall">
                At least one deposit is short of its deductions. That balance is shown as it is; "Returned" stays off until finance decides what to do about it.
              </p>
            )}
          </CardContent>
        </Card>

        {statementFor && (() => {
          const deposit = deposits.find((d) => d.residentId === statementFor.id);
          return deposit ? (
            <DepositStatement
              resident={statementFor}
              deposit={deposit}
              deductions={deductions.filter((d) => d.residentId === statementFor.id)}
              houseDeductions={deductions}
              open
              onOpenChange={(open) => !open && setStatementFor(null)}
            />
          ) : null;
        })()}
      </>
    );
  }

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Move-out damages"
            description={walkthrough ? `${walkthrough.buildingAddress} · ${formatDate(walkthrough.walkthroughDate)}` : undefined}
            actions={
              <Button variant="ghost" asChild>
                <Link href={`/walkthroughs/${walkthroughId}`} data-testid="link-worksheet-back">
                  <ArrowLeft className="h-4 w-4" />
                  Walkthrough
                </Link>
              </Button>
            }
          />
          <p className="text-sm text-muted-foreground">
            Amounts, dates and references only — the money moves in QuickBooks and Ramp. Every charge lands on the person's own deposit ledger and in the activity trail. Residents never see this screen.
          </p>
          {body}
        </PageStack>
      </Container>
    </Section>
  );
}

function balanceShortfall(residents: Resident[], deposits: SecurityDeposit[], deductions: DepositDeduction[]): boolean {
  return residents.some((resident) => {
    const deposit = deposits.find((d) => d.residentId === resident.id);
    if (!deposit) return false;
    return runningBalance(deposit.amountHeld, deductions.filter((d) => d.residentId === resident.id)) < 0;
  });
}
