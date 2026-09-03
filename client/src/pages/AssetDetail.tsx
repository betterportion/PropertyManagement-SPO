import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AlarmClock, ArrowLeft, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import LifecycleBadge from "@/components/asset/LifecycleBadge";
import SnoozeDialog from "@/components/asset/SnoozeDialog";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency, formatDate, formatValue } from "@/lib/format";
import { DEFAULT_LIFESPAN_YEARS, assetLifecycle } from "@shared/assetLifecycle";
import type { Asset, AssetPhoto, MaintenanceContact, Resident, User } from "@shared/schema";

/**
 * Everything about one asset.
 *
 * The reason this page exists is institutional memory. Where a thing came
 * from, which supplier, how that went — that knowledge currently dies at RA
 * handover, and it is exactly what somebody needs when the same appliance
 * fails again in four years.
 *
 * It reads the list endpoints the rest of the app already uses and narrows
 * here. At SPO's size the lists are small and usually already cached from the
 * page the user arrived from, so there is no per-asset endpoint and this does
 * not add one.
 */

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

export default function AssetDetail() {
  const params = useParams<{ id: string }>();
  const assetId = params.id;
  const { user } = useAuth();

  const [isSnoozeOpen, setIsSnoozeOpen] = useState(false);

  const assetsQuery = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const photosQuery = useQuery<AssetPhoto[]>({ queryKey: ["/api/asset-photos"] });
  const contactsQuery = useQuery<MaintenanceContact[]>({ queryKey: ["/api/contacts"] });
  const residentsQuery = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  const usersQuery = useQuery<User[]>({ queryKey: ["/api/users"], retry: false });

  // Computed below every hook, never returned on above one: a guard placed
  // over a useQuery changes the hook count when the auth query resolves.
  const typedUser = user as { role?: string; permissions?: Record<string, boolean> } | null;
  const canManage =
    typedUser?.role === "admin" || typedUser?.permissions?.canManageAssets === true;

  const asset = assetsQuery.data?.find((candidate) => candidate.id === assetId);
  const photos = useMemo(
    () => (photosQuery.data ?? []).filter((photo) => photo.assetId === assetId),
    [photosQuery.data, assetId],
  );

  const supplier = asset?.supplierContactId
    ? contactsQuery.data?.find((contact) => contact.id === asset.supplierContactId)
    : undefined;

  /**
   * Who has it, if anybody.
   *
   * A real reference wherever one exists — a resident or a staff account — and
   * the free-text name only as the fallback for somebody who is neither.
   */
  const assignee = useMemo(() => {
    if (!asset) return null;
    if (asset.assignedResidentId) {
      const resident = residentsQuery.data?.find((r) => r.id === asset.assignedResidentId);
      if (resident) return `${resident.firstName} ${resident.lastName}`;
    }
    if (asset.assignedUserId) {
      const person = usersQuery.data?.find((u) => u.id === asset.assignedUserId);
      if (person) return [person.firstName, person.lastName].filter(Boolean).join(" ") || person.email;
    }
    return asset.assignedToName ?? null;
  }, [asset, residentsQuery.data, usersQuery.data]);

  const isLoading = assetsQuery.isLoading;

  if (isLoading) {
    return (
      <Section size="compact">
        <Container>
          <LoadingState message="Loading this asset..." />
        </Container>
      </Section>
    );
  }

  if (!asset) {
    return (
      <Section size="compact">
        <Container>
          <PageStack>
            <Button variant="ghost" asChild data-testid="link-back-to-assets">
              <Link href="/assets">
                <ArrowLeft className="h-4 w-4" />
                Assets
              </Link>
            </Button>
            <EmptyState
              title="This asset could not be opened"
              description="It may have been deleted, or it belongs to a region you do not cover."
            />
          </PageStack>
        </Container>
      </Section>
    );
  }

  const lifecycle = assetLifecycle(asset);
  const categoryDefault = DEFAULT_LIFESPAN_YEARS[asset.category];

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
            title={asset.name}
            description={`${asset.category} · ${asset.location} · ${asset.buildingAddress}`}
            actions={
              canManage ? (
                <Button
                  variant="secondary"
                  onClick={() => setIsSnoozeOpen(true)}
                  data-testid="button-open-snooze"
                >
                  <AlarmClock className="h-4 w-4" />
                  {lifecycle.snoozed ? "Snoozed" : "Snooze"}
                </Button>
              ) : undefined
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{asset.region}</Badge>
            <Badge variant="secondary">{asset.type === "fixed" ? "Fixed" : "Movable"}</Badge>
            <LifecycleBadge asset={asset} showDate />
          </div>

          {lifecycle.snoozed && asset.snoozeReason && (
            <p
              className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
              data-testid="text-snooze-reason-detail"
            >
              Snoozed until {formatDate(asset.snoozedUntil)} — {asset.snoozeReason}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Life and replacement</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="Acquired" value={asset.acquisitionDate ? formatDate(asset.acquisitionDate) : formatValue(null)} />
                <Fact
                  label="Expected life"
                  value={
                    asset.expectedLifespanYears
                      ? `${asset.expectedLifespanYears} years`
                      : categoryDefault
                        ? `${categoryDefault} years (category default)`
                        : formatValue(null)
                  }
                />
                <Fact
                  label="Replacement due"
                  value={lifecycle.dueDate ? formatDate(lifecycle.dueDate) : formatValue(null)}
                />
                <Fact label="Last serviced" value={asset.lastServiced ? formatDate(asset.lastServiced) : formatValue(null)} />
              </dl>

              {lifecycle.status === "unrated" && (
                <p className="mt-4 text-sm text-muted-foreground" data-testid="text-unrated-explainer">
                  Nothing here says when this was acquired or when it is due, so it is left unrated
                  rather than guessed at. Adding an acquisition date, or a replacement date
                  directly, is what starts the clock.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Worth and identity</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                {/* Both, never one instead of the other: used equipment can be
                    worth more than it cost, insurance cares about value rather
                    than purchase price, and the purchase price is history
                    nothing can rebuild once dropped. */}
                <Fact label="Purchase price" value={asset.purchasePrice ? formatCurrency(asset.purchasePrice) : formatValue(null)} />
                <Fact
                  label="Current value"
                  value={
                    asset.currentValue ? (
                      <>
                        {formatCurrency(asset.currentValue)}
                        {asset.valuedOn && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            as of {formatDate(asset.valuedOn)}
                          </span>
                        )}
                      </>
                    ) : (
                      formatValue(null)
                    )
                  }
                />
                <Fact label="Serial number" value={formatValue(asset.serialNumber)} />
                <Fact label="Asset tag" value={formatValue(asset.assetTagId)} />
              </dl>
            </CardContent>
          </Card>

          {asset.type === "movable" && (
            <Card>
              <CardHeader>
                <CardTitle>Who has it</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <Fact label="Assigned to" value={formatValue(assignee)} />
                  <Fact
                    label="Expected back"
                    value={asset.expectedReturnDate ? formatDate(asset.expectedReturnDate) : formatValue(null)}
                  />
                </dl>
                {assignee && (
                  <Button variant="secondary" size="sm" className="mt-4" asChild>
                    <Link href="/assets/assigned" data-testid="link-assigned-view">
                      Everything assigned to people
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Where it came from</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <Fact
                  label="Supplier"
                  value={
                    supplier ? (
                      <Link
                        href="/contacts"
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                        data-testid="link-asset-supplier"
                      >
                        {supplier.company} — {supplier.name}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    ) : (
                      formatValue(null)
                    )
                  }
                />
              </dl>

              {asset.acquisitionNotes ? (
                <p className="whitespace-pre-line text-sm" data-testid="text-acquisition-notes">
                  {asset.acquisitionNotes}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing recorded about how this was bought or how the supplier worked out. That
                  is the kind of thing the next RA has no other way to find out.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Photos</CardTitle>
            </CardHeader>
            <CardContent>
              {photos.length === 0 ? (
                <EmptyState
                  title="No photos of this asset yet"
                  description="A photo of the model plate is the fastest way for the next person to order the right part."
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {photos.map((photo) => (
                    <figure key={photo.id} data-testid={`figure-asset-photo-${photo.id}`}>
                      {/* Dimensions are unknown until the image loads, so the
                          fixed-ratio box is what stops the page shifting under
                          the reader as each one arrives. */}
                      <div className="aspect-square overflow-hidden rounded-md border border-border bg-muted">
                        <img
                          src={photo.imageUrl}
                          alt={photo.caption ?? `${asset.name} photo`}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      </div>
                      {photo.caption && (
                        <figcaption className="mt-1 text-xs text-muted-foreground">
                          {photo.caption}
                        </figcaption>
                      )}
                    </figure>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <SnoozeDialog asset={asset} open={isSnoozeOpen} onOpenChange={setIsSnoozeOpen} />
        </PageStack>
      </Container>
    </Section>
  );
}
