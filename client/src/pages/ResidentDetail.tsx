import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, Mail, Package, Phone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import DepositLedger from "@/components/deposit/DepositLedger";
import ResidentPaperwork from "@/components/ResidentPaperwork";
import { useAuth } from "@/hooks/useAuth";
import { formatDate, formatValue } from "@/lib/format";
import type { Asset, Property, Resident, SecurityDeposit } from "@shared/schema";

/**
 * Everything about one person on a roster, in one place.
 *
 * The pieces already existed and were spread across three screens — their
 * deposit on Finances, their assigned equipment under Assets, their paperwork
 * on the property page. That is fine when you are working through deposits or
 * through assets, and useless when the question is "what is the situation with
 * this person", which is what somebody actually holds in their head when
 * somebody is moving out.
 *
 * **Staff-facing only.** Nothing here is exposed to a resident account; the
 * deposit ledger in particular is admins and the finance team only, and it is
 * rendered only for somebody who can already read it.
 *
 * Reads the list endpoints the rest of the app uses and narrows here, matching
 * `PropertyDetail`: at SPO's size the lists are small and usually already
 * cached from the page the user came from.
 */

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

export default function ResidentDetail() {
  const params = useParams<{ id: string }>();
  const residentId = params.id;
  const { user } = useAuth();

  const residentsQuery = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const assetsQuery = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  // Finance-gated on the server; a lead without the flag simply gets nothing
  // back and the ledger below is not rendered.
  const depositsQuery = useQuery<SecurityDeposit[]>({
    queryKey: ["/api/security-deposits"],
    retry: false,
  });

  // Computed below every hook, never returned on above one.
  const typedUser = user as { role?: string; permissions?: Record<string, boolean> } | null;
  const isAdmin = typedUser?.role === "admin";
  const canManageFinance = isAdmin || typedUser?.permissions?.canManageFinancials === true;
  const canSeeFinance =
    canManageFinance || typedUser?.permissions?.canViewFinancials === true;
  const canManageProperties = isAdmin || typedUser?.permissions?.canManageProperties === true;

  const resident = residentsQuery.data?.find((candidate) => candidate.id === residentId);
  const property = propertiesQuery.data?.find((candidate) => candidate.id === resident?.propertyId);
  const deposit = depositsQuery.data?.find((candidate) => candidate.residentId === residentId);

  const assigned = useMemo(
    () => (assetsQuery.data ?? []).filter((asset) => asset.assignedResidentId === residentId),
    [assetsQuery.data, residentId],
  );

  if (residentsQuery.isLoading) {
    return (
      <Section size="compact">
        <Container>
          <LoadingState message="Loading this resident..." />
        </Container>
      </Section>
    );
  }

  if (!resident) {
    return (
      <Section size="compact">
        <Container>
          <PageStack>
            <Button variant="ghost" className="w-fit" asChild>
              <Link href="/residents" data-testid="link-back-to-residents">
                <ArrowLeft className="h-4 w-4" />
                Residents
              </Link>
            </Button>
            <EmptyState
              title="This resident could not be opened"
              description="They may have been removed, or they live in a region you do not cover."
            />
          </PageStack>
        </Container>
      </Section>
    );
  }

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Button variant="ghost" className="w-fit" asChild>
            <Link href="/residents" data-testid="link-back-to-residents">
              <ArrowLeft className="h-4 w-4" />
              Residents
            </Link>
          </Button>

          <PageHeader
            title={`${resident.firstName} ${resident.lastName}`}
            description={resident.buildingAddress}
          />

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant={resident.isActive ? "success" : "secondary"} data-testid="badge-resident-status">
              {resident.isActive ? "Living here" : "Moved out"}
            </Badge>
            <Badge variant="secondary">{resident.region}</Badge>
            <a
              className="inline-flex items-center gap-1 underline underline-offset-2"
              href={`mailto:${resident.email}`}
              data-testid="link-resident-email"
            >
              <Mail className="h-3.5 w-3.5" />
              {resident.email}
            </a>
            {resident.phone && (
              <a
                className="inline-flex items-center gap-1 underline underline-offset-2"
                href={`tel:${resident.phone}`}
                data-testid="link-resident-phone"
              >
                <Phone className="h-3.5 w-3.5" />
                {resident.phone}
              </a>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>The basics</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Fact
                  label="House"
                  value={
                    property ? (
                      <Link
                        href={`/properties/${property.id}`}
                        className="underline underline-offset-2"
                        data-testid="link-resident-property"
                      >
                        {property.name}
                      </Link>
                    ) : (
                      formatValue(resident.buildingAddress)
                    )
                  }
                />
                <Fact
                  label="Moved in"
                  value={resident.moveInDate ? formatDate(resident.moveInDate) : formatValue(null)}
                />
                <Fact
                  label="Moved out"
                  value={resident.moveOutDate ? formatDate(resident.moveOutDate) : formatValue(null)}
                />
                <Fact
                  label="Agreed deposit"
                  value={formatValue(resident.depositAmountOverride ?? null)}
                />
              </dl>
              {resident.notes && (
                <p className="mt-4 whitespace-pre-line text-sm" data-testid="text-resident-notes">
                  {resident.notes}
                </p>
              )}
            </CardContent>
          </Card>

          <ResidentPaperwork resident={resident} canManage={canManageProperties} />

          {/* Only for somebody who can already read deposits. Residents never
              see any of this, and neither does a lead without the flag. */}
          {canSeeFinance && deposit && (
            <DepositLedger resident={resident} deposit={deposit} canManage={canManageFinance} />
          )}

          <Card>
            <CardHeader>
              <CardTitle>What they have of SPO's</CardTitle>
            </CardHeader>
            <CardContent>
              {assigned.length === 0 ? (
                <EmptyState
                  icon={Package}
                  title="Nothing is assigned to them"
                  description="Assign a movable asset to this person and it appears here with the date it is expected back — which is what makes collecting it before they leave possible."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {assigned.map((asset) => (
                    <li
                      key={asset.id}
                      className="flex items-center gap-3 py-2"
                      data-testid={`row-resident-asset-${asset.id}`}
                    >
                      <Link
                        href={`/assets/${asset.id}`}
                        className="min-w-0 flex-1 truncate font-medium hover:underline"
                      >
                        {asset.name}
                      </Link>
                      {asset.expectedReturnDate && (
                        <Badge
                          variant={
                            new Date(asset.expectedReturnDate) < new Date() ? "destructive" : "secondary"
                          }
                        >
                          Back {formatDate(asset.expectedReturnDate)}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </PageStack>
      </Container>
    </Section>
  );
}
