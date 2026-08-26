import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, Building2, Package, UsersRound, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/data-table";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { formatCurrency, formatDate, formatValue } from "@/lib/format";
import type {
  Asset,
  MaintenanceRequest,
  MaintenanceSchedule,
  Property,
  RentPayment,
  Resident,
  SecurityDeposit,
} from "@shared/schema";

/**
 * Everything about one house, in one place.
 *
 * The portal's other pages each answer a question across the whole portfolio
 * ("which requests are open?"). This answers every question about a single
 * property, which is what somebody actually holds in their head when they walk
 * into a house.
 *
 * It reads the same list endpoints the rest of the app uses and narrows them
 * here. There is no per-property endpoint and this does not add one: at SPO's
 * size the lists are small and already in the query cache from the pages the
 * user came from.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The current month as "YYYY-MM", read from the local calendar. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Matches the wording on the Safety page so one house reads the same in both. */
function scheduleStatus(schedule: MaintenanceSchedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(schedule.nextDueDate);
  const days = Math.round((due.getTime() - today.getTime()) / DAY);
  if (days < 0) return { label: "Overdue", variant: "destructive" as const };
  if (days <= 30) return { label: "Due soon", variant: "warning" as const };
  return { label: "Up to date", variant: "success" as const };
}

const REQUEST_STATUS: Record<
  MaintenanceRequest["status"],
  { label: string; variant: "warning" | "info" | "success" | "secondary" }
> = {
  pending: { label: "Pending", variant: "warning" },
  in_progress: { label: "In progress", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

const RENT_STATUS: Record<
  RentPayment["status"],
  { label: string; variant: "success" | "destructive" | "secondary" }
> = {
  paid: { label: "Paid", variant: "success" },
  unpaid: { label: "Unpaid", variant: "destructive" },
  waived: { label: "Waived", variant: "secondary" },
  failed: { label: "Payment failed", variant: "destructive" },
};

const DEPOSIT_STATUS: Record<
  SecurityDeposit["status"],
  { label: string; variant: "info" | "success" | "warning" | "destructive" }
> = {
  held: { label: "Held", variant: "info" },
  returned: { label: "Returned", variant: "success" },
  partially_returned: { label: "Partly returned", variant: "warning" },
  withheld: { label: "Withheld", variant: "destructive" },
};

export default function PropertyDetail() {
  const params = useParams<{ id: string }>();
  const propertyId = params.id;

  // No GET /api/properties/:id exists, and adding one is not worth it at this
  // size -- the list is already cached from the Properties page.
  const propertiesQuery = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const residentsQuery = useQuery<Resident[]>({ queryKey: ["/api/residents"] });
  const requestsQuery = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });
  const schedulesQuery = useQuery<MaintenanceSchedule[]>({
    queryKey: ["/api/maintenance-schedules"],
  });
  const assetsQuery = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const rentQuery = useQuery<RentPayment[]>({ queryKey: ["/api/rent-payments"] });
  const depositsQuery = useQuery<SecurityDeposit[]>({ queryKey: ["/api/security-deposits"] });

  const property = propertiesQuery.data?.find((p) => p.id === propertyId);

  const residents = useMemo(
    () =>
      (residentsQuery.data ?? [])
        .filter((r) => r.propertyId === propertyId)
        .sort((a, b) => Number(b.isActive) - Number(a.isActive)),
    [residentsQuery.data, propertyId],
  );

  // Requests carry the address rather than a property id, so this is the join.
  const requests = useMemo(
    () =>
      property
        ? (requestsQuery.data ?? []).filter((r) => r.buildingAddress === property.address)
        : [],
    [requestsQuery.data, property],
  );

  const schedules = useMemo(
    () => (schedulesQuery.data ?? []).filter((s) => s.propertyId === propertyId),
    [schedulesQuery.data, propertyId],
  );

  const assets = useMemo(
    () => (assetsQuery.data ?? []).filter((a) => a.propertyId === propertyId),
    [assetsQuery.data, propertyId],
  );

  /** This month's rent row per resident, so the roster can show where they stand. */
  const rentThisMonth = useMemo(() => {
    const period = currentPeriod();
    return new Map(
      (rentQuery.data ?? [])
        .filter((p) => p.propertyId === propertyId && p.period === period)
        .map((p) => [p.residentId, p]),
    );
  }, [rentQuery.data, propertyId]);

  const depositsByResident = useMemo(
    () =>
      new Map(
        (depositsQuery.data ?? [])
          .filter((d) => d.propertyId === propertyId)
          .map((d) => [d.residentId, d]),
      ),
    [depositsQuery.data, propertyId],
  );

  const activeResidents = residents.filter((r) => r.isActive);
  const openRequests = requests.filter(
    (r) => r.status === "pending" || r.status === "in_progress",
  );
  const overdueSchedules = schedules.filter(
    (s) => s.isActive && scheduleStatus(s).label === "Overdue",
  );

  if (propertiesQuery.isLoading) {
    return (
      <Section size="compact">
        <Container>
          <LoadingState message="Loading this property..." />
        </Container>
      </Section>
    );
  }

  if (!property) {
    return (
      <Section size="compact">
        <Container>
          <PageStack>
            <BackLink />
            <EmptyState
              icon={Building2}
              title="That property is not here"
              description="It may have been removed, or it may be in a region you do not have access to."
              action={
                <Button variant="secondary" asChild>
                  <Link href="/properties">Back to properties</Link>
                </Button>
              }
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
          <BackLink />

          <PageHeader title={property.name} description={property.address} />

          <div className="flex flex-wrap items-center gap-2" data-testid="property-facts">
            <Badge variant="secondary">{property.region}</Badge>
            {property.chapter && <Badge variant="secondary">{property.chapter}</Badge>}
            {property.bedrooms !== null && property.bedrooms !== undefined && (
              <Badge variant="outline">
                {activeResidents.length} of {property.bedrooms} beds filled
              </Badge>
            )}
            {openRequests.length > 0 && (
              <Badge variant="warning">
                {openRequests.length === 1 ? "1 open request" : `${openRequests.length} open requests`}
              </Badge>
            )}
            {overdueSchedules.length > 0 && (
              <Badge variant="destructive">
                {overdueSchedules.length === 1
                  ? "1 overdue check"
                  : `${overdueSchedules.length} overdue checks`}
              </Badge>
            )}
          </div>

          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Property manager" value={formatValue(property.propertyManager)} />
            <Fact
              label="Bedrooms"
              value={formatValue(property.bedrooms)}
            />
            <Fact label="Bathrooms" value={formatValue(property.bathrooms)} />
            <Fact
              label="Square footage"
              value={
                property.squareFootage === null || property.squareFootage === undefined
                  ? formatValue(null)
                  : property.squareFootage.toLocaleString("en-US")
              }
            />
          </dl>

          <Tabs defaultValue="residents">
            <TabsList>
              <TabsTrigger value="residents" data-testid="tab-residents">
                Residents
              </TabsTrigger>
              <TabsTrigger value="maintenance" data-testid="tab-maintenance">
                Maintenance
              </TabsTrigger>
              <TabsTrigger value="assets" data-testid="tab-assets">
                Assets
              </TabsTrigger>
            </TabsList>

            <TabsContent value="residents" className="mt-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <UsersRound className="h-4 w-4" />
                    Who lives here
                  </CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/residents" data-testid="link-all-residents">
                      Manage roster
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  <DataTable
                    rows={residents}
                    getRowId={(r) => r.id}
                    isLoading={residentsQuery.isLoading}
                    defaultSort={{ key: "name" }}
                    data-testid="table-property-residents"
                    empty={
                      <EmptyState
                        title="Nobody is on the roster for this house yet"
                        description="Add residents on the Residents page and they will appear here."
                      />
                    }
                    columns={[
                      {
                        key: "name",
                        header: "Name",
                        sortValue: (r) => `${r.lastName} ${r.firstName}`,
                        cell: (r) => (
                          <span className="font-medium">
                            {r.firstName} {r.lastName}
                            {!r.isActive && (
                              <Badge variant="secondary" className="ml-2">
                                Moved out
                              </Badge>
                            )}
                          </span>
                        ),
                      },
                      {
                        key: "email",
                        header: "Email",
                        sortValue: (r) => r.email,
                        cell: (r) => formatValue(r.email),
                        hideOnMobile: true,
                      },
                      {
                        key: "movedIn",
                        header: "Moved in",
                        sortValue: (r) => r.moveInDate,
                        cell: (r) => formatDate(r.moveInDate),
                        hideOnMobile: true,
                      },
                      {
                        key: "rent",
                        header: "Rent this month",
                        sortValue: (r) => rentThisMonth.get(r.id)?.status ?? "",
                        cell: (r) => {
                          const payment = rentThisMonth.get(r.id);
                          if (!payment) return formatValue(null);
                          const status = RENT_STATUS[payment.status];
                          return (
                            <span className="flex items-center gap-2">
                              <Badge variant={status.variant}>{status.label}</Badge>
                              <span className="tabular-nums text-muted-foreground">
                                {formatCurrency(payment.amount)}
                              </span>
                            </span>
                          );
                        },
                      },
                      {
                        key: "deposit",
                        header: "Deposit",
                        sortValue: (r) => depositsByResident.get(r.id)?.status ?? "",
                        cell: (r) => {
                          const deposit = depositsByResident.get(r.id);
                          if (!deposit) return formatValue(null);
                          const status = DEPOSIT_STATUS[deposit.status];
                          return <Badge variant={status.variant}>{status.label}</Badge>;
                        },
                        hideOnMobile: true,
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="maintenance" className="mt-4 space-y-6">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Wrench className="h-4 w-4" />
                    Requests
                  </CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/maintenance" data-testid="link-all-maintenance">
                      All maintenance
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  <DataTable
                    rows={requests}
                    getRowId={(r) => r.id}
                    isLoading={requestsQuery.isLoading}
                    defaultSort={{ key: "submitted", direction: "desc" }}
                    data-testid="table-property-requests"
                    empty={
                      <EmptyState
                        title="No requests have been reported for this house"
                        description="Anything a resident reports here will show up in this tab."
                      />
                    }
                    columns={[
                      {
                        key: "title",
                        header: "Request",
                        sortValue: (r) => r.title,
                        cell: (r) => <span className="font-medium">{r.title}</span>,
                      },
                      {
                        key: "priority",
                        header: "Priority",
                        sortValue: (r) => r.priority,
                        cell: (r) => <span className="capitalize">{r.priority}</span>,
                        hideOnMobile: true,
                      },
                      {
                        key: "status",
                        header: "Status",
                        sortValue: (r) => r.status,
                        cell: (r) => {
                          const status = REQUEST_STATUS[r.status];
                          return <Badge variant={status.variant}>{status.label}</Badge>;
                        },
                      },
                      {
                        key: "submitted",
                        header: "Reported",
                        sortValue: (r) => r.submittedDate,
                        cell: (r) => formatDate(r.submittedDate),
                        hideOnMobile: true,
                      },
                    ]}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">Safety &amp; upkeep schedule</CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/safety" data-testid="link-all-safety">
                      All schedules
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  <DataTable
                    rows={schedules}
                    getRowId={(s) => s.id}
                    isLoading={schedulesQuery.isLoading}
                    defaultSort={{ key: "due" }}
                    data-testid="table-property-schedules"
                    empty={
                      <EmptyState
                        title="No recurring checks set up for this house"
                        description="Add them on the Safety page, or apply the standard template there."
                      />
                    }
                    columns={[
                      {
                        key: "title",
                        header: "Task",
                        sortValue: (s) => s.title,
                        cell: (s) => <span className="font-medium">{s.title}</span>,
                      },
                      {
                        key: "category",
                        header: "Kind",
                        sortValue: (s) => s.category,
                        cell: (s) => <span className="capitalize">{s.category}</span>,
                        hideOnMobile: true,
                      },
                      {
                        key: "due",
                        header: "Next due",
                        sortValue: (s) => s.nextDueDate,
                        cell: (s) => formatDate(s.nextDueDate),
                      },
                      {
                        key: "state",
                        header: "State",
                        sortValue: (s) => new Date(s.nextDueDate).getTime(),
                        cell: (s) => {
                          const status = scheduleStatus(s);
                          return <Badge variant={status.variant}>{status.label}</Badge>;
                        },
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="assets" className="mt-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Package className="h-4 w-4" />
                    Appliances and equipment
                  </CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/assets" data-testid="link-all-assets">
                      All assets
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  <DataTable
                    rows={assets}
                    getRowId={(a) => a.id}
                    isLoading={assetsQuery.isLoading}
                    defaultSort={{ key: "name" }}
                    data-testid="table-property-assets"
                    empty={
                      <EmptyState
                        title="Nothing is tracked at this house yet"
                        description="Appliances and equipment added on the Assets page will appear here."
                      />
                    }
                    columns={[
                      {
                        key: "name",
                        header: "Asset",
                        sortValue: (a) => a.name,
                        cell: (a) => <span className="font-medium">{a.name}</span>,
                      },
                      {
                        key: "category",
                        header: "Category",
                        sortValue: (a) => a.category,
                        cell: (a) => formatValue(a.category),
                        hideOnMobile: true,
                      },
                      {
                        key: "location",
                        header: "Where",
                        sortValue: (a) => a.location,
                        cell: (a) => formatValue(a.location),
                      },
                      {
                        key: "age",
                        header: "Age",
                        align: "right",
                        sortValue: (a) => a.ageInYears,
                        cell: (a) => `${a.ageInYears} yr`,
                        hideOnMobile: true,
                      },
                      {
                        key: "serviced",
                        header: "Last serviced",
                        sortValue: (a) => a.lastServiced,
                        cell: (a) => formatDate(a.lastServiced),
                        hideOnMobile: true,
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </PageStack>
      </Container>
    </Section>
  );
}

function BackLink() {
  return (
    <Link
      href="/properties"
      className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="link-back-to-properties"
    >
      <ArrowLeft className="h-4 w-4" />
      Properties
    </Link>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
