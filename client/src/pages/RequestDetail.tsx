import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, HardHat, Pencil, Phone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { AccessDeniedState, EmptyState, ErrorState, LoadingState } from "@/components/states";
import MaintenanceEditDialog from "@/components/MaintenanceEditDialog";
import RequestThread from "@/components/RequestThread";
import { useAuth } from "@/hooks/useAuth";
import { isForbiddenError } from "@/lib/authUtils";
import { formatDate, formatValue } from "@/lib/format";
import { REQUEST_PRIORITY, REQUEST_STATUS } from "@/lib/requestLabels";
import {
  isClosedMaintenanceStatus,
  type MaintenanceContact,
  type MaintenanceRequest,
  type MaintenanceRequestComment,
  type MaintenanceRequestPhoto,
} from "@shared/schema";

/**
 * One request, on its own page.
 *
 * Until now a request was only ever a card in a list with an edit dialog, so a
 * thread, bids, a contract link and costs had nowhere to live. This is the
 * screen those land on; today it shows what already exists.
 *
 * It is registered in both role switches at the same path, the way the
 * walkthrough page is, and decides nothing about access itself: it fetches
 * `GET /api/maintenance-requests/:id` and shows whatever comes back. The
 * server's request read rule -- ownership or house for a resident, region for
 * staff -- is the only thing between a reader and a request, and a 403 from
 * it is what the access-denied state below reports.
 */

/** The shape of `/api/auth/user` this page reads. */
interface RequestUser {
  id?: string | null;
  role?: string | null;
  permissions?: { canManageMaintenance?: boolean | null } | null;
}

function isStaffAccount(user: RequestUser | null): boolean {
  return user?.role === "admin" || user?.role === "regional_administrator";
}

/**
 * Mirrors the PATCH route's guard: staff, and either an admin or the manage
 * flag. A resident holding the flag on their row is still refused there, so
 * they are not offered a button every press of which would fail.
 */
function canEditRequest(user: RequestUser | null): boolean {
  if (!isStaffAccount(user)) return false;
  return user?.role === "admin" || user?.permissions?.canManageMaintenance === true;
}

function Fact({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export default function RequestDetail() {
  const params = useParams<{ id: string }>();
  const requestId = params.id;
  const { user } = useAuth();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const requestQuery = useQuery<MaintenanceRequest>({
    queryKey: ["/api/maintenance-requests", requestId],
    enabled: !!requestId,
  });

  // The same list the cards read, narrowed here, so a photo added from the
  // list is already in the cache when this page opens. The server has already
  // dropped every photo on a request the caller may not read.
  const photosQuery = useQuery<MaintenanceRequestPhoto[]>({
    queryKey: ["/api/maintenance-request-photos"],
  });

  // Same key as the edit dialog's, so linking a contractor there refreshes
  // the list here without a second invalidation.
  const contactsQuery = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/maintenance-requests", requestId, "contacts"],
    enabled: !!requestId,
  });

  // The thread, fetched alongside the request rather than after it: the
  // server has already filtered it to what this caller may read.
  const commentsQuery = useQuery<MaintenanceRequestComment[]>({
    queryKey: ["/api/maintenance-requests", requestId, "comments"],
    enabled: !!requestId,
  });

  // Computed below every hook, never returned on above one: a guard placed
  // over a useQuery changes the hook count when the auth query resolves.
  const typedUser = user as RequestUser | null;
  const isStaff = isStaffAccount(typedUser);
  const canEdit = canEditRequest(typedUser);

  const request = requestQuery.data;
  const photos = useMemo(
    () => (photosQuery.data ?? []).filter((photo) => photo.requestId === requestId),
    [photosQuery.data, requestId],
  );
  const contacts = contactsQuery.data ?? [];

  const forbidden = requestQuery.error instanceof Error && isForbiddenError(requestQuery.error);

  // Where "back" goes depends on which list the reader came from: staff have
  // the maintenance list, a household has its own.
  const backLink = isStaff
    ? { href: "/maintenance", label: "Maintenance requests" }
    : { href: "/my-requests", label: "My requests" };

  let body: React.ReactNode;
  if (requestQuery.isLoading) {
    body = <LoadingState message="Loading this request..." />;
  } else if (forbidden) {
    body = (
      <AccessDeniedState
        description={
          isStaff
            ? "This request belongs to a region you do not cover."
            : "This request belongs to another house, or it was closed long enough ago that it is no longer shown."
        }
      />
    );
  } else if (requestQuery.isError || !request) {
    body = (
      <ErrorState
        message="This request could not be opened. It may have been deleted."
        onRetry={() => requestQuery.refetch()}
      />
    );
  } else {
    const status = REQUEST_STATUS[request.status];
    const priority = REQUEST_PRIORITY[request.priority];
    const isClosed = isClosedMaintenanceStatus(request.status);

    body = (
      <>
        <PageHeader
          title={request.title}
          description={`${request.category} · ${request.location} · ${request.buildingAddress}`}
          actions={
            canEdit ? (
              <Button variant="secondary" onClick={() => setIsEditOpen(true)} data-testid="button-edit-request">
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
            ) : undefined
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant} data-testid="badge-request-status">
            {status.label}
          </Badge>
          <Badge variant={priority.variant} data-testid="badge-request-priority">
            {priority.label} priority
          </Badge>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>What was reported</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="whitespace-pre-line text-sm" data-testid="text-request-description">
              {request.description}
            </p>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Where in the house" value={formatValue(request.location)} testId="text-request-location" />
              <Fact label="House" value={formatValue(request.buildingAddress)} testId="text-request-house" />
              <Fact label="Reported by" value={formatValue(request.submittedBy)} testId="text-request-submitted-by" />
              <Fact label="Reported on" value={formatDate(request.submittedDate)} testId="text-request-submitted-on" />
              {/* Only when closed: an open request has no close date, and an
                  em-dash there reads as something missing. */}
              {isClosed && (
                <Fact label="Closed on" value={formatDate(request.completedDate)} testId="text-request-closed-on" />
              )}
              {isStaff && <Fact label="Region" value={formatValue(request.region)} />}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Photos</CardTitle>
          </CardHeader>
          <CardContent>
            {!request.photoUrl && photos.length === 0 ? (
              <EmptyState
                title="No photos on this request"
                description="A photo of the problem is the quickest way for whoever fixes it to know what to bring."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="request-photos">
                {/* The one filed with the request first, then anything added
                    since, each saying who added it and when. */}
                {request.photoUrl && (
                  <figure data-testid="figure-request-photo-filed">
                    <div className="aspect-square overflow-hidden rounded-md border border-border bg-muted">
                      <img
                        src={request.photoUrl}
                        alt={`${request.title}, as reported`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <figcaption className="mt-1 text-xs text-muted-foreground">Filed with the request</figcaption>
                  </figure>
                )}
                {photos.map((photo) => (
                  <figure key={photo.id} data-testid={`figure-request-photo-${photo.id}`}>
                    <div className="aspect-square overflow-hidden rounded-md border border-border bg-muted">
                      <img
                        src={photo.imageUrl}
                        alt={`${request.title}, added ${formatDate(photo.uploadedDate)}`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <figcaption className="mt-1 text-xs text-muted-foreground">
                      Added by {photo.uploadedBy} on {formatDate(photo.uploadedDate)}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contractors</CardTitle>
          </CardHeader>
          <CardContent>
            {contactsQuery.isLoading ? (
              <LoadingState message="Loading contractors..." className="h-24" />
            ) : contactsQuery.isError ? (
              <ErrorState
                message="The contractors on this request could not be loaded."
                onRetry={() => contactsQuery.refetch()}
              />
            ) : contacts.length === 0 ? (
              <EmptyState
                icon={HardHat}
                title="No contractor is linked to this request"
                description={
                  canEdit
                    ? "Link one from Edit once somebody has been asked to look at it."
                    : "Once the property team has asked somebody to look at it, they will be listed here."
                }
              />
            ) : (
              <ul className="divide-y divide-border" data-testid="list-request-contacts">
                {contacts.map((contact) => (
                  <li
                    key={contact.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                    data-testid={`row-request-contact-${contact.id}`}
                  >
                    <div className="min-w-0">
                      {/* The contractor's own page is a staff screen; a
                          household gets the name and the number. */}
                      {isStaff ? (
                        <Link
                          href={`/contacts/${contact.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                          data-testid={`link-request-contact-${contact.id}`}
                        >
                          {contact.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{contact.name}</span>
                      )}
                      <p className="text-muted-foreground">
                        {contact.company} · {contact.service}
                      </p>
                    </div>
                    {contact.phone && (
                      <a
                        href={`tel:${contact.phone}`}
                        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline"
                        data-testid={`link-request-contact-phone-${contact.id}`}
                      >
                        <Phone className="h-3 w-3" />
                        {contact.phone}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <RequestThread
          requestId={request.id}
          commentsQuery={commentsQuery}
          isStaff={isStaff}
          isAdmin={typedUser?.role === "admin"}
          currentUserId={typedUser?.id ?? null}
        />

        {canEdit && (
          <MaintenanceEditDialog request={request} open={isEditOpen} onClose={() => setIsEditOpen(false)} />
        )}
      </>
    );
  }

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Button variant="ghost" className="w-fit" asChild data-testid="link-back-to-requests">
            <Link href={backLink.href}>
              <ArrowLeft className="h-4 w-4" />
              {backLink.label}
            </Link>
          </Button>
          {body}
        </PageStack>
      </Container>
    </Section>
  );
}
