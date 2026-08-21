import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Phone, Mail, DollarSign, FileText, Pencil, ExternalLink } from "lucide-react";
import type { BillingRecord, MaintenanceContact } from "@shared/schema";
import { EmptyState } from "@/components/states";
import { formatCurrency } from "@/lib/format";

interface ContactsInvoicesProps {
  contacts: MaintenanceContact[];
  invoices: BillingRecord[];
  onAddContact?: () => void;
  onEditContact?: (id: string) => void;
  onAddInvoice?: () => void;
  onViewInvoice?: (id: string) => void;
}

export default function ContactsInvoices({ contacts, invoices, onEditContact }: ContactsInvoicesProps) {
  return (
    <Tabs defaultValue="contacts" className="w-full">
      <TabsList className="grid w-full grid-cols-2" data-testid="tabs-contacts-invoices">
        <TabsTrigger value="contacts" data-testid="tab-contacts">
          Contacts ({contacts.length})
        </TabsTrigger>
        <TabsTrigger value="invoices" data-testid="tab-invoices">
          Invoices ({invoices.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="mt-6">
        <div className="space-y-4">
          {contacts.length === 0 ? (
            <EmptyState title="Your maintenance directory is clear" description="Add a vendor contact when a new service relationship is ready to track." />
          ) : contacts.map((contact) => (
            <Card key={contact.id} className="hover-elevate" data-testid={`card-contact-${contact.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h4 className="font-semibold text-base" data-testid={`text-contact-name-${contact.id}`}>
                      {contact.name}
                    </h4>
                    <p className="text-sm text-muted-foreground">{contact.company}</p>
                    <Badge variant="secondary" className="mt-2">
                      {contact.service}
                    </Badge>
                    <div className="flex flex-col gap-2 mt-3">
                      <a
                        href={`tel:${contact.phone}`}
                        className="flex items-center gap-2 text-sm hover-elevate active-elevate-2 p-1 rounded-md -ml-1"
                      >
                        <Phone className="h-4 w-4" />
                        <span>{contact.phone}</span>
                      </a>
                      <a
                        href={`mailto:${contact.email}`}
                        className="flex items-center gap-2 text-sm hover-elevate active-elevate-2 p-1 rounded-md -ml-1"
                      >
                        <Mail className="h-4 w-4" />
                        <span>{contact.email}</span>
                      </a>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEditContact?.(contact.id)}
                    data-testid={`button-edit-contact-${contact.id}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </TabsContent>

      <TabsContent value="invoices" className="mt-6">
        <div className="space-y-4">
          {invoices.length === 0 && (
            <EmptyState title="No invoices are waiting here" description="Create an invoice record to keep vendor costs and documents attached to the right contact." />
          )}
          {invoices.map((invoice) => (
            <Card key={invoice.id} className="hover-elevate" data-testid={`card-invoice-${invoice.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1">
                    <h4 className="font-semibold text-base" data-testid={`text-invoice-company-${invoice.id}`}>
                      {invoice.companyName}
                    </h4>
                    <div className="flex flex-wrap gap-4 mt-2 text-sm">
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">
                          {formatCurrency(invoice.invoiceCost)}
                        </span>
                      </div>
                      {invoice.email && (
                        <a href={`mailto:${invoice.email}`} className="flex items-center gap-2 hover-elevate rounded-sm">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <span>{invoice.email}</span>
                        </a>
                      )}
                      {invoice.phone && (
                        <a href={`tel:${invoice.phone}`} className="flex items-center gap-2 hover-elevate rounded-sm">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span>{invoice.phone}</span>
                        </a>
                      )}
                    </div>
                    {(invoice.contractInvoiceUrl || invoice.coiUrl || invoice.w9Url) && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {invoice.contractInvoiceUrl && (
                          <a
                            href={invoice.contractInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-contract-${invoice.id}`}
                          >
                            <Badge variant="secondary" className="gap-1 cursor-pointer">
                              <FileText className="h-3 w-3" />
                              Contract/Invoice
                              <ExternalLink className="h-3 w-3" />
                            </Badge>
                          </a>
                        )}
                        {invoice.coiUrl && (
                          <a
                            href={invoice.coiUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-coi-${invoice.id}`}
                          >
                            <Badge variant="secondary" className="gap-1 cursor-pointer">
                              <FileText className="h-3 w-3" />
                              COI
                              <ExternalLink className="h-3 w-3" />
                            </Badge>
                          </a>
                        )}
                        {invoice.w9Url && (
                          <a
                            href={invoice.w9Url}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-w9-${invoice.id}`}
                          >
                            <Badge variant="secondary" className="gap-1 cursor-pointer">
                              <FileText className="h-3 w-3" />
                              W-9
                              <ExternalLink className="h-3 w-3" />
                            </Badge>
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}
