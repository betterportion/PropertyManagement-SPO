import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, ChevronRight, PackageOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { formatDate } from "@/lib/format";
import type { Asset, Resident, User } from "@shared/schema";

/**
 * Everything SPO has lent out, by the person holding it.
 *
 * Built for one situation in particular: somebody is leaving, and there is an
 * iPad, a guitar and a laptop to collect before he does. A field on each asset
 * would not answer that — it would mean opening every asset to find out — so
 * the view is by person rather than by thing.
 *
 * Grouped on the client over `/api/assets`, which is already region-scoped by
 * the server and already cached from the Assets page. There is no per-person
 * endpoint and this does not add one: a new route would mean a new guard, and
 * the answer is a regrouping of a list the caller can already read.
 */

/** One person and what they are holding. */
interface Holder {
  key: string;
  name: string;
  /** How SPO knows them, which is not the same as who they are. */
  kind: "resident" | "staff" | "name only";
  assets: Asset[];
}

/** Overdue first: those are the ones somebody has to chase. */
function overdueFirst(a: Asset, b: Asset): number {
  const at = a.expectedReturnDate ? new Date(a.expectedReturnDate).getTime() : Infinity;
  const bt = b.expectedReturnDate ? new Date(b.expectedReturnDate).getTime() : Infinity;
  return at - bt;
}

export default function AssignedAssets() {
  const assetsQuery = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const residentsQuery = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  // Only an account holding canManageUsers can read this. Everyone else gets a
  // staff assignment shown by its stored fallback name rather than a broken
  // page, which is why the failure is quiet by design.
  const usersQuery = useQuery<User[]>({ queryKey: ["/api/users"], retry: false });

  const holders = useMemo<Holder[]>(() => {
    const residents = new Map((residentsQuery.data ?? []).map((r) => [r.id, r]));
    const staff = new Map((usersQuery.data ?? []).map((u) => [u.id, u]));
    const grouped = new Map<string, Holder>();

    for (const asset of assetsQuery.data ?? []) {
      // A real reference wherever one exists; free text only as the fallback
      // for somebody who is neither a resident nor a staff account.
      let key: string | null = null;
      let name: string | null = null;
      let kind: Holder["kind"] = "name only";

      if (asset.assignedResidentId) {
        const resident = residents.get(asset.assignedResidentId);
        key = `resident:${asset.assignedResidentId}`;
        name = resident ? `${resident.firstName} ${resident.lastName}` : "A resident who has been removed";
        kind = "resident";
      } else if (asset.assignedUserId) {
        const person = staff.get(asset.assignedUserId);
        key = `staff:${asset.assignedUserId}`;
        name =
          (person && ([person.firstName, person.lastName].filter(Boolean).join(" ") || person.email)) ||
          asset.assignedToName ||
          "A staff account";
        kind = "staff";
      } else if (asset.assignedToName?.trim()) {
        key = `name:${asset.assignedToName.trim().toLowerCase()}`;
        name = asset.assignedToName.trim();
        kind = "name only";
      }

      if (!key || !name) continue;

      const existing = grouped.get(key);
      if (existing) existing.assets.push(asset);
      else grouped.set(key, { key, name, kind, assets: [asset] });
    }

    for (const holder of Array.from(grouped.values())) holder.assets.sort(overdueFirst);
    return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [assetsQuery.data, residentsQuery.data, usersQuery.data]);

  const isLoading = assetsQuery.isLoading;
  const today = new Date();

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Button variant="ghost" className="w-fit" asChild data-testid="link-back-to-assets">
            <Link href="/assets">
              <ArrowLeft className="h-4 w-4" />
              Assets
            </Link>
          </Button>

          <PageHeader
            title="Who has what"
            description="Everything lent out, by the person holding it. Useful when somebody is leaving."
          />

          {isLoading ? (
            <LoadingState message="Working out who has what..." />
          ) : holders.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="Nothing is assigned to anybody right now"
              description="Assign a movable asset to a resident or a staff member and it appears here, with the date it is expected back."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {holders.map((holder) => (
                <Card key={holder.key} data-testid={`card-holder-${holder.key}`}>
                  <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                    <CardTitle className="text-base">{holder.name}</CardTitle>
                    <Badge variant="secondary">
                      {holder.assets.length} item{holder.assets.length === 1 ? "" : "s"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {/* "Name only" is worth saying: it means there is no record
                        to follow when this person leaves, which is exactly the
                        case this page exists for. */}
                    {holder.kind === "name only" && (
                      <p className="pb-2 text-xs text-muted-foreground">
                        Recorded by name only — not linked to a resident or an account.
                      </p>
                    )}

                    {holder.assets.map((asset) => {
                      const due = asset.expectedReturnDate ? new Date(asset.expectedReturnDate) : null;
                      const overdue = due !== null && due < today;
                      return (
                        <Link
                          key={asset.id}
                          href={`/assets/${asset.id}`}
                          className="flex items-center gap-2 rounded-md border-b border-border py-2 last:border-b-0 hover:underline"
                          data-testid={`link-assigned-asset-${asset.id}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{asset.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {asset.category} · {asset.buildingAddress}
                            </span>
                          </span>
                          {due && (
                            <Badge
                              variant={overdue ? "destructive" : "secondary"}
                              data-testid={`badge-return-${asset.id}`}
                            >
                              {overdue ? "Overdue" : "Back"} {formatDate(due)}
                            </Badge>
                          )}
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </Link>
                      );
                    })}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </PageStack>
      </Container>
    </Section>
  );
}
