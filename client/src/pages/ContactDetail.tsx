import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CLOSEOUT_QUESTIONS, isGoodAnswer, type CloseoutQuestionKey } from "@shared/closeouts";
import { Link, useParams } from "wouter";
import { ArrowLeft, Mail, Phone, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import type {
  BillingRecord,
  ContactNote,
  Invoice,
  MaintenanceContact,
  MaintenanceRequest,
} from "@shared/schema";

/**
 * Everything SPO knows about one contractor.
 *
 * The concern this answers is handover: what an RA learned working with a
 * vendor — that they turned up late twice, that they are the only ones who
 * will touch this boiler — currently lives in one person's head and leaves
 * with them.
 *
 * Most of what is here is a read over data that already existed.
 * `request_contacts` has linked vendors to requests all along and invoices
 * already carry a `contactId`; there was simply nowhere to read it from.
 *
 * **There is no rating.** A star score on a vendor SPO may have to keep using
 * invites arguments about the number, and tells an incoming RA far less than a
 * paragraph does. Dated notes in somebody's own words are the record kept.
 */

const REQUEST_STATUS: Record<string, { label: string; variant: "warning" | "info" | "success" | "secondary" }> = {
  pending: { label: "Pending", variant: "warning" },
  in_progress: { label: "In progress", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

/** What GET /api/contacts/:id/closeouts answers (server/contractorSummary.ts). */
interface ContractorSummaryView {
  answered: number;
  counts: Array<{ key: CloseoutQuestionKey; label: string; yes: number; of: number }>;
  history: Array<{
    requestId: string;
    title: string;
    buildingAddress: string;
    completedAt: string;
    note: string | null;
    completedByName: string | null;
    answers: Record<CloseoutQuestionKey, boolean | null>;
  }>;
}

export default function ContactDetail() {
  const params = useParams<{ id: string }>();
  const contactId = params.id;
  const { user } = useAuth();
  const { toast } = useToast();

  const [draft, setDraft] = useState("");

  const contactsQuery = useQuery<MaintenanceContact[]>({ queryKey: ["/api/contacts"] });
  const requestsQuery = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/contacts", contactId, "requests"],
    enabled: !!contactId,
  });
  const notesQuery = useQuery<ContactNote[]>({
    queryKey: ["/api/contacts", contactId, "notes"],
    enabled: !!contactId,
  });
  const closeoutsQuery = useQuery<ContractorSummaryView>({
    queryKey: ["/api/contacts", contactId, "closeouts"],
    enabled: !!contactId,
  });
  const invoicesQuery = useQuery<Invoice[]>({ queryKey: ["/api/invoices"] });
  const billingQuery = useQuery<BillingRecord[]>({ queryKey: ["/api/billing"], retry: false });

  // Computed below every hook, never returned on above one.
  const typedUser = user as { role?: string; permissions?: Record<string, boolean> } | null;
  const canManage =
    typedUser?.role === "admin" || typedUser?.permissions?.canManageContacts === true;

  const contact = contactsQuery.data?.find((candidate) => candidate.id === contactId);

  const invoices = useMemo(
    () => (invoicesQuery.data ?? []).filter((invoice) => invoice.contactId === contactId),
    [invoicesQuery.data, contactId],
  );
  const billing = useMemo(
    () => (billingQuery.data ?? []).filter((record) => record.contactId === contactId),
    [billingQuery.data, contactId],
  );

  const addNote = useMutation({
    mutationFn: async () => await apiRequest("POST", `/api/contacts/${contactId}/notes`, { body: draft }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "notes"] });
      setDraft("");
    },
    onError: (error) => {
      toast({
        title: "That note did not save",
        description: serverMessage(error) ?? "Nothing was recorded. Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const removeNote = useMutation({
    mutationFn: async (noteId: string) => await apiRequest("DELETE", `/api/contact-notes/${noteId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId, "notes"] });
    },
    onError: (error) => {
      toast({ title: "That note was not deleted", description: serverMessage(error), variant: "destructive" });
    },
  });

  if (contactsQuery.isLoading) {
    return (
      <Section size="compact">
        <Container>
          <LoadingState message="Loading this contractor..." />
        </Container>
      </Section>
    );
  }

  if (!contact) {
    return (
      <Section size="compact">
        <Container>
          <PageStack>
            <Button variant="ghost" className="w-fit" asChild>
              <Link href="/contacts" data-testid="link-back-to-contacts">
                <ArrowLeft className="h-4 w-4" />
                Contacts
              </Link>
            </Button>
            <EmptyState
              title="This contractor could not be opened"
              description="They may have been removed, or they belong to a region you do not cover."
            />
          </PageStack>
        </Container>
      </Section>
    );
  }

  const requests = requestsQuery.data ?? [];

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <Button variant="ghost" className="w-fit" asChild>
            <Link href="/contacts" data-testid="link-back-to-contacts">
              <ArrowLeft className="h-4 w-4" />
              Contacts
            </Link>
          </Button>

          <PageHeader title={contact.company} description={`${contact.name} · ${contact.service}`} />

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Badge variant="secondary">{contact.region}</Badge>
            <a className="inline-flex items-center gap-1 underline underline-offset-2" href={`tel:${contact.phone}`} data-testid="link-contact-phone">
              <Phone className="h-3.5 w-3.5" />
              {contact.phone}
            </a>
            <a className="inline-flex items-center gap-1 underline underline-offset-2" href={`mailto:${contact.email}`} data-testid="link-contact-email">
              <Mail className="h-3.5 w-3.5" />
              {contact.email}
            </a>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What the last RA learned</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Dated entries, no score. A number invites an argument about
                  the number; a paragraph tells the next person what happened. */}
              {canManage && (
                <div className="space-y-2">
                  <Textarea
                    rows={3}
                    value={draft}
                    maxLength={2000}
                    placeholder="What happened, and what the next RA should know. e.g. Came out same day for the burst pipe; will not do tile."
                    onChange={(event) => setDraft(event.target.value)}
                    data-testid="textarea-contact-note"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={draft.trim().length === 0 || addNote.isPending}
                    onClick={() => addNote.mutate()}
                    data-testid="button-add-contact-note"
                  >
                    {addNote.isPending ? "Saving…" : "Add note"}
                  </Button>
                </div>
              )}

              {notesQuery.isLoading ? (
                <LoadingState message="Loading notes..." />
              ) : (notesQuery.data ?? []).length === 0 ? (
                <EmptyState
                  title="Nothing recorded about working with them yet"
                  description="The first note is worth more than it looks — it is what an incoming RA has instead of asking around."
                />
              ) : (
                <ul className="space-y-3">
                  {(notesQuery.data ?? []).map((note) => (
                    <li
                      key={note.id}
                      className="flex items-start gap-3 rounded-md border border-border p-3"
                      data-testid={`note-${note.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line text-sm">{note.body}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {/* The email is kept on the row so a note still says
                              who wrote it after that account is gone. */}
                          {note.authorEmail ?? "Someone no longer with SPO"} ·{" "}
                          {formatDateTime(note.createdAt)}
                        </p>
                      </div>
                      {canManage && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete this note"
                          onClick={() => removeNote.mutate(note.id)}
                          data-testid={`button-delete-note-${note.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-contact-closeouts">
            <CardHeader>
              <CardTitle>How their jobs went</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Counts and the dated history, never an average: "7 of 9"
                  tells the next RA something a 3.8 does not (launch
                  readiness 2.4). */}
              {closeoutsQuery.isLoading ? (
                <LoadingState message="Loading their close-outs..." />
              ) : !closeoutsQuery.data || closeoutsQuery.data.history.length === 0 ? (
                <EmptyState
                  title="No completed job has been closed out with them yet"
                  description="When a request they are linked to is marked completed, the RA answers four quick questions. The counts start with the first one."
                />
              ) : (
                <>
                  <ul className="grid gap-2 sm:grid-cols-2" data-testid="list-closeout-counts">
                    {closeoutsQuery.data.counts.map((count) => (
                      <li key={count.key} className="rounded-md border border-border px-3 py-2 text-sm" data-testid={`text-closeout-count-${count.key}`}>
                        {count.label}: <span className="font-semibold">{count.yes} of {count.of}</span>
                      </li>
                    ))}
                  </ul>
                  <ul className="space-y-3" data-testid="list-closeout-history">
                    {closeoutsQuery.data.history.map((job) => (
                      <li key={job.requestId} className="rounded-md border border-border p-3 text-sm" data-testid={`row-closeout-${job.requestId}`}>
                        <Link href={`/maintenance/${job.requestId}`} className="font-medium underline-offset-2 hover:underline">
                          {job.title}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {job.buildingAddress} · completed {formatDate(job.completedAt)}
                          {job.completedByName ? ` by ${job.completedByName}` : ""}
                        </p>
                        <p className="mt-1 flex flex-wrap gap-1">
                          {CLOSEOUT_QUESTIONS.map(({ key, rollup }) =>
                            job.answers[key] === null ? null : (
                              <Badge key={key} variant={isGoodAnswer(key, job.answers[key]) ? "success" : "outline"}>
                                {rollup}: {job.answers[key] ? "yes" : "no"}
                              </Badge>
                            ),
                          )}
                        </p>
                        {job.note && <p className="mt-2 whitespace-pre-line">{job.note}</p>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Every job they touched</CardTitle>
            </CardHeader>
            <CardContent>
              {requestsQuery.isLoading ? (
                <LoadingState message="Loading their jobs..." />
              ) : requests.length === 0 ? (
                <EmptyState
                  title="No requests are linked to them yet"
                  description="Link a contractor to a maintenance request and every job they worked on collects here."
                />
              ) : (
                <ul className="space-y-1">
                  {requests.map((request) => {
                    const status = REQUEST_STATUS[request.status] ?? { label: request.status, variant: "secondary" as const };
                    return (
                      <li
                        key={request.id}
                        className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
                        data-testid={`row-contact-request-${request.id}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{request.title}</span>
                          <span className="block text-xs text-muted-foreground">
                            {request.buildingAddress} · {request.location}
                            {request.submittedDate ? ` · ${formatDate(request.submittedDate)}` : ""}
                          </span>
                        </span>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invoices and billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {invoices.length === 0 && billing.length === 0 ? (
                <EmptyState
                  title="Nothing billed through them yet"
                  description="Invoices raised against this contractor appear here alongside their billing record."
                />
              ) : (
                <>
                  {invoices.map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
                      data-testid={`row-contact-invoice-${invoice.id}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {invoice.invoiceNumber} — {invoice.service}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Due {formatDate(invoice.dueDate)}
                        </span>
                      </span>
                      <span className="font-medium">{formatCurrency(invoice.amount)}</span>
                      <Badge variant={invoice.status === "paid" ? "success" : "warning"}>
                        {invoice.status}
                      </Badge>
                    </div>
                  ))}

                  {billing.map((record) => (
                    <div
                      key={record.id}
                      className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
                      data-testid={`row-contact-billing-${record.id}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        Billing record — {record.companyName}
                      </span>
                      <span className="font-medium">{formatCurrency(record.invoiceCost)}</span>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        </PageStack>
      </Container>
    </Section>
  );
}
