import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { MaintenanceRequest, MaintenanceContact, Invoice, Property } from "@shared/schema";
import { DollarSign, Link2, FileText, Plus, Check, X, ImageIcon } from "lucide-react";
import { PhotoUpload } from "@/components/PhotoUpload";
import { format } from "date-fns";

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
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  location: z.string().min(1, "Location is required"),
  photoUrl: z.string().nullable().optional(),
});

type EditFormData = z.infer<typeof editSchema>;

export default function MaintenanceEditDialog({ request, open, onClose }: MaintenanceEditDialogProps) {
  const { toast } = useToast();
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);

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
    },
    onError: () => {
      toast({ title: "Failed to link contact", variant: "destructive" });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (contactId: string) =>
      apiRequest('DELETE', `/api/maintenance-requests/${request.id}/contacts/${contactId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests', request.id, 'contacts'] });
    },
    onError: () => {
      toast({ title: "Failed to unlink contact", variant: "destructive" });
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
      status: request.status,
      location: request.location,
      photoUrl: request.photoUrl ?? null,
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: EditFormData) => {
      return await apiRequest('PATCH', `/api/maintenance-requests/${request.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/maintenance-requests'] });
      toast({
        title: "Request updated",
        description: "Maintenance request has been updated successfully",
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Update failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: EditFormData) => {
    updateMutation.mutate(data);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Maintenance Request</DialogTitle>
          <DialogDescription>
            Update request details, link contacts, and manage invoices
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
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowInvoiceForm(!showInvoiceForm)}
                  data-testid="button-add-invoice"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Create Invoice
                </Button>
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
                            Due: {format(new Date(invoice.dueDate), "MMM d, yyyy")}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold flex items-center gap-1">
                            <DollarSign className="h-3 w-3" />
                            {invoice.amount}
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

              {showInvoiceForm && (
                <Card className="p-4">
                  <p className="text-sm text-muted-foreground">
                    To create an invoice for this maintenance request, go to the Invoices section and link it to request "{request.title}".
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => setShowInvoiceForm(false)}
                  >
                    Close
                  </Button>
                </Card>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
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
