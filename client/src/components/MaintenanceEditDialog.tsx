import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { CommentAttachmentField, type PendingAttachment } from "@/components/CommentAttachmentField";
import { CLOSEOUT_QUESTIONS, closeoutProblem, joinNames, type CloseoutQuestionKey } from "@shared/closeouts";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import { MAINTENANCE_REQUEST_TYPES, isProjectType, type MaintenanceRequest, type MaintenanceContact, type Invoice, type Property } from "@shared/schema";
import { REQUEST_TYPE } from "@/lib/requestLabels";
import { DollarSign, Link2, FileText, Check, X, ImageIcon, Lock, Users } from "lucide-react";
import { PhotoUpload } from "@/components/PhotoUpload";
import { formatCurrency, formatDate } from "@/lib/format";

interface MaintenanceEditDialogProps {
  request: MaintenanceRequest;
  open: boolean;
  onClose: () => void;
}

const editSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  category: z.string().min(1, "Category is required"),
  priority: z.enum(["low", "medium", "high", "urgent", "wishlist"]),
  type: z.enum(MAINTENANCE_REQUEST_TYPES),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  location: z.string().min(1, "Location is required"),
  photoUrl: z.string().nullable().optional(),
  // The project fields, held as the strings the inputs produce; onSubmit
  // turns them into what the API takes, and sends them only for a project
  // or a capital project -- the server refuses them on a repair.
  contractUrl: z.string(),
  estimatedCost: z.string(),
  actualCost: z.string(),
  targetYear: z.string(),
  targetQuarter: z.string(),
});

type EditFormData = z.infer<typeof editSchema>;

/** The quarter select cannot hold an empty value, so "none" stands for it. */
const NO_QUARTER = "none";

/** A number input's empty string is "not set", never zero. */
const numberOrNull = (value: string) => (value.trim() === "" ? null : value.trim());

/** What the update sends for the project fields: the values for a project, nothing for a repair. */
function projectFieldsPayload(data: EditFormData): Record<string, unknown> {
  if (!isProjectType(data.type)) return {};
  return {
    contractUrl: data.contractUrl.trim(),
    estimatedCost: numberOrNull(data.estimatedCost),
    actualCost: numberOrNull(data.actualCost),
    targetYear: numberOrNull(data.targetYear),
    targetQuarter: data.targetQuarter === NO_QUARTER ? null : data.targetQuarter,
  };
}

/** The close-out as the dialog holds it: unanswered is null, never false. */
interface CloseoutDraft {
  answers: Record<CloseoutQuestionKey, boolean | null>;
  note: string;
  whatWasDone: string;
  internal: boolean;
}

const EMPTY_CLOSEOUT: CloseoutDraft = {
  answers: { firstVisit: null, quoteMatched: null, callback: null, wouldUseAgain: null },
  note: "",
  whatWasDone: "",
  internal: true,
};

export default function MaintenanceEditDialog({ request, open, onClose }: MaintenanceEditDialogProps) {
  const { toast } = useToast();
  // The close-out (launch readiness 2.4): shown on the move to Completed,
  // on this control, never on a page of its own. Held outside the form
  // because the four answers are a three-state thing a form field is not.
  const [closeout, setCloseout] = useState<CloseoutDraft>(EMPTY_CLOSEOUT);
  const [closeoutFile, setCloseoutFile] = useState<PendingAttachment | null>(null);
  const [closeoutProblemText, setCloseoutProblemText] = useState<string | null>(null);

  const { data: contacts = [] } = useQuery<MaintenanceContact[]>({
    queryKey: ['/api/contacts'],
    enabled: open,
  });

  const { data: linkedContacts = [] } = useQuery<MaintenanceContact[]>({
    queryKey: ['/api/maintenance-requests', request.id, 'contacts'],
    enabled: open,
  });

  const linkedContactIds = new Set(linkedContacts.map(c => c.id));

  const linkMutation = useMutation({
    mutationFn: async (contactId: string) =>
      apiRequest('POST', `/api/maintenance-requests/${request.id}/contacts/${contactId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests', request.id, 'contacts'] });
      // The Patterns tab rolls up requests and contractor links; nothing refetches on its own.
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-aggregates'] });
    },
    onError: (error) => {
      toast({ title: "Failed to link contact", description: serverMessage(error), variant: "destructive" });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (contactId: string) =>
      apiRequest('DELETE', `/api/maintenance-requests/${request.id}/contacts/${contactId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests', request.id, 'contacts'] });
      // The Patterns tab rolls up requests and contractor links; nothing refetches on its own.
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-aggregates'] });
    },
    onError: (error) => {
      toast({ title: "Failed to unlink contact", description: serverMessage(error), variant: "destructive" });
    },
  });

  const toggleContact = (contactId: string) => {
    if (linkedContactIds.has(contactId)) {
      unlinkMutation.mutate(contactId);
    } else {
      linkMutation.mutate(contactId);
    }
  };

  const { data: invoices = [] } = useQuery<Invoice[]>({
    queryKey: ['/api/invoices'],
    enabled: open,
  });

  const { data: properties = [] } = useQuery<Property[]>({
    queryKey: ['/api/properties'],
    enabled: open,
  });

  const relatedInvoices = invoices.filter(inv => inv.maintenanceRequestId === request.id);

  const form = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      title: request.title,
      description: request.description,
      category: request.category,
      priority: request.priority,
      type: request.type,
      status: request.status,
      location: request.location,
      photoUrl: request.photoUrl ?? null,
      contractUrl: request.contractUrl ?? "",
      estimatedCost: request.estimatedCost ?? "",
      actualCost: request.actualCost ?? "",
      targetYear: request.targetYear != null ? String(request.targetYear) : "",
      targetQuarter: request.targetQuarter != null ? String(request.targetQuarter) : NO_QUARTER,
    },
  });

  /** Completing, as the server sees it: the move to Completed, not a re-save of one. */
  const watchedStatus = useWatch({ control: form.control, name: "status" });
  const completing = watchedStatus === "completed" && request.status !== "completed";
  const contractorNames = linkedContacts.map((c) => c.company || c.name);

  const updateMutation = useMutation({
    mutationFn: async (data: EditFormData) => {
      const { contractUrl: _c, estimatedCost: _e, actualCost: _a, targetYear: _y, targetQuarter: _q, ...rest } = data;
      const closeoutPayload = completing
        ? {
            closeout: {
              ...closeout.answers,
              note: closeout.note,
              whatWasDone: closeout.whatWasDone,
              whatWasDoneInternal: closeout.internal,
              attachmentUrl: closeoutFile?.url ?? null,
              attachmentName: closeoutFile?.name ?? null,
            },
          }
        : {};
      return await apiRequest('PATCH', `/api/maintenance-requests/${request.id}`, { ...rest, ...projectFieldsPayload(data), ...closeoutPayload });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests'] });
      // The Patterns tab rolls up requests and contractor links; nothing refetches on its own.
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-aggregates'] });
      // A close-out lands on the request page, in its thread, and on every linked contractor's page.
      queryClient.invalidateQueries({ queryKey: ['/api/contacts'] });
      setCloseout(EMPTY_CLOSEOUT);
      setCloseoutFile(null);
      setCloseoutProblemText(null);
      toast({
        title: "Request updated",
        description: "Maintenance request has been updated successfully",
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Update failed",
        description: serverMessage(error) ?? "Check the details and try again.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: EditFormData) => {
    // The server's own sentence, shown before the round trip rather than
    // after it, so a missing answer is a line on screen and never a disabled
    // button with no explanation.
    if (completing) {
      const problem = closeoutProblem({ ...closeout.answers, note: closeout.note }, contractorNames);
      setCloseoutProblemText(problem);
      if (problem) return;
    }
    updateMutation.mutate(data);
  };

  const answer = (key: CloseoutQuestionKey, value: boolean) =>
    setCloseout((draft) => ({ ...draft, answers: { ...draft.answers, [key]: value } }));

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Maintenance Request</DialogTitle>
          <DialogDescription>
            Update request details, link contacts, and see linked invoices
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-title" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} data-testid="input-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-category" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location (Property)</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-location">
                          <SelectValue placeholder="Select property" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {properties.filter(p => p.address).map((property) => (
                          <SelectItem key={property.id} value={property.address!}>
                            {property.address}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-priority">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="urgent">Urgent</SelectItem>
                        <SelectItem value="wishlist">Wishlist</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MAINTENANCE_REQUEST_TYPES.map((type) => (
                          <SelectItem key={type} value={type} data-testid={`option-type-${type}`}>
                            {REQUEST_TYPE[type].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Said beside the control, not in a help page: changing
                        a type away from Repair takes the request off the
                        household's screen, and somebody doing that should
                        know it before they save. */}
                    <p className="text-xs text-muted-foreground" data-testid="text-type-resident-note">
                      Projects and capital projects are not shown to residents.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-status">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* The close-out: four facts and a note when a contractor is
                linked, "what was done" always. Appears on the move to
                Completed and nowhere else (launch readiness 2.4). */}
            {completing && (
              <div className="space-y-4 rounded-md border border-border p-4" data-testid="section-closeout">
                <div>
                  <h3 className="text-sm font-semibold">Closing this request out</h3>
                  <p className="text-xs text-muted-foreground">
                    {linkedContacts.length > 0
                      ? `Four quick facts about ${joinNames(contractorNames)} and a note, for whoever hires them next. No scores.`
                      : "No contractor is linked, so there is nothing to answer. Say what was done if it helps the next person."}
                  </p>
                </div>

                {linkedContacts.length > 0 && (
                  <div className="space-y-3" data-testid="section-closeout-questions">
                    {CLOSEOUT_QUESTIONS.map(({ key, label }) => (
                      <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">{label}</span>
                        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label={label}>
                          <Button
                            type="button"
                            size="sm"
                            variant={closeout.answers[key] === true ? "primary" : "ghost"}
                            aria-pressed={closeout.answers[key] === true}
                            onClick={() => answer(key, true)}
                            data-testid={`button-closeout-${key}-yes`}
                          >
                            Yes
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={closeout.answers[key] === false ? "primary" : "ghost"}
                            aria-pressed={closeout.answers[key] === false}
                            onClick={() => answer(key, false)}
                            data-testid={`button-closeout-${key}-no`}
                          >
                            No
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="space-y-1">
                      <Label htmlFor="closeout-note">How it went (required)</Label>
                      <Textarea
                        id="closeout-note"
                        rows={3}
                        maxLength={4000}
                        value={closeout.note}
                        onChange={(e) => setCloseout((draft) => ({ ...draft, note: e.target.value }))}
                        placeholder="e.g. Came the same day, left the kitchen clean. Would not do tile."
                        data-testid="textarea-closeout-note"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <Label htmlFor="closeout-what-was-done">What was done <span className="text-xs text-muted-foreground">(optional)</span></Label>
                  <Textarea
                    id="closeout-what-was-done"
                    rows={3}
                    maxLength={10000}
                    value={closeout.whatWasDone}
                    onChange={(e) => setCloseout((draft) => ({ ...draft, whatWasDone: e.target.value }))}
                    placeholder="Goes on the request's thread. Screenshots of texts and emails are welcome as the file."
                    data-testid="textarea-closeout-what-was-done"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Who sees what was done">
                    <Button
                      type="button"
                      size="sm"
                      variant={closeout.internal ? "primary" : "ghost"}
                      aria-pressed={closeout.internal}
                      onClick={() => setCloseout((draft) => ({ ...draft, internal: true }))}
                      data-testid="button-closeout-visibility-internal"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Internal
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={closeout.internal ? "ghost" : "primary"}
                      aria-pressed={!closeout.internal}
                      onClick={() => setCloseout((draft) => ({ ...draft, internal: false }))}
                      data-testid="button-closeout-visibility-shared"
                    >
                      <Users className="h-3.5 w-3.5" />
                      Shared
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {closeout.internal ? "Staff only." : "The household will see this."}
                  </span>
                </div>
                <CommentAttachmentField
                  requestId={request.id}
                  value={closeoutFile}
                  onChange={setCloseoutFile}
                  onError={(message) => toast({ title: "File not attached", description: message, variant: "destructive" })}
                  disabled={updateMutation.isPending}
                  hint="One file, attached to what was done. PDF, Word or an image, up to 20MB."
                />
                {closeoutProblemText && (
                  <p role="alert" className="text-sm text-destructive" data-testid="text-closeout-problem">
                    {closeoutProblemText}
                  </p>
                )}
              </div>
            )}

            {/* Only for a project or a capital project: a repair's form
                stays a repair's form, and the server refuses these on one. */}
            {isProjectType(form.watch("type")) && (
              <div className="space-y-3" data-testid="section-project-fields">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Project details
                </h3>
                <FormField
                  control={form.control}
                  name="contractUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Signed contract (link)</FormLabel>
                      <FormControl>
                        <Input {...field} type="url" placeholder="https://drive.google.com/..." data-testid="input-contract-url" />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        A link to where the signed agreement lives, on Drive or Adobe. The portal never holds a copy.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="estimatedCost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Estimated cost ($)</FormLabel>
                        <FormControl>
                          <Input {...field} type="number" min={0} step="0.01" data-testid="input-estimated-cost" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="actualCost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Actual cost ($)</FormLabel>
                        <FormControl>
                          <Input {...field} type="number" min={0} step="0.01" data-testid="input-actual-cost" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="targetYear"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Target year</FormLabel>
                        <FormControl>
                          <Input {...field} type="number" min={2000} max={2100} step={1} placeholder="e.g. 2027" data-testid="input-target-year" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="targetQuarter"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Target quarter</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-target-quarter">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={NO_QUARTER}>Any time that year</SelectItem>
                            {["1", "2", "3", "4"].map((quarter) => (
                              <SelectItem key={quarter} value={quarter} data-testid={`option-target-quarter-${quarter}`}>
                                Q{quarter}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Costs are amounts only; the money moves in QuickBooks and Ramp. A target period is a year or a quarter,
                  never a date, because these slip by design.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4" />
                Photo
              </h3>
              <PhotoUpload
                onUpload={(url) => form.setValue("photoUrl", url)}
                onRemove={() => form.setValue("photoUrl", null)}
                existingUrl={form.watch("photoUrl") ?? undefined}
              />
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  Linked Contacts
                </h3>
                {linkedContacts.length > 0 && (
                  <Badge variant="secondary" className="text-xs">{linkedContacts.length} linked</Badge>
                )}
              </div>
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No contacts available. Add contacts in the Contacts section.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {contacts.map((contact) => {
                    const isLinked = linkedContactIds.has(contact.id);
                    const isPending = linkMutation.isPending || unlinkMutation.isPending;
                    return (
                      <button
                        key={contact.id}
                        type="button"
                        onClick={() => toggleContact(contact.id)}
                        disabled={isPending}
                        data-testid={`button-toggle-contact-${contact.id}`}
                        className={`w-full text-left rounded-md border p-3 transition-colors ${
                          isLinked
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5 min-w-0">
                            <p className="font-medium text-sm truncate">{contact.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{contact.company}</p>
                            <p className="text-xs text-muted-foreground truncate">{contact.service}</p>
                          </div>
                          <div className={`mt-0.5 flex-shrink-0 rounded-full p-0.5 ${isLinked ? "bg-primary text-primary-foreground" : "border border-border"}`}>
                            {isLinked ? <Check className="h-3 w-3" /> : <X className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Related Invoices
                </h3>
              </div>

              {relatedInvoices.length > 0 ? (
                <div className="space-y-2">
                  {relatedInvoices.map((invoice) => (
                    <Card key={invoice.id} className="p-3">
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <p className="font-medium text-sm">{invoice.invoiceNumber}</p>
                          <p className="text-xs text-muted-foreground">{invoice.service}</p>
                            <p className="text-xs text-muted-foreground">
                             Due: {formatDate(invoice.dueDate)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold flex items-center gap-1">
                            <DollarSign className="h-3 w-3" />
                            {formatCurrency(invoice.amount)}
                          </p>
                          <Badge variant="outline" className="mt-1">
                            {invoice.status}
                          </Badge>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No invoices linked to this request</p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={updateMutation.isPending}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={updateMutation.isPending}
                data-testid="button-save"
              >
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
