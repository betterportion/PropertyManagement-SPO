import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Phone, Mail, DollarSign, Calendar, FileText, Pencil } from "lucide-react";

interface Contact {
  id: string;
  name: string;
  company: string;
  service: string;
  phone: string;
  email: string;
}

interface Invoice {
  id: string;
  vendor: string;
  service: string;
  amount: number;
  dueDate: Date;
  status: "paid" | "pending" | "overdue";
  invoiceNumber: string;
}

interface ContactsInvoicesProps {
  contacts: Contact[];
  invoices: Invoice[];
  onAddContact?: () => void;
  onEditContact?: (id: string) => void;
  onAddInvoice?: () => void;
  onViewInvoice?: (id: string) => void;
}

const statusColors = {
  paid: "bg-chart-2 text-white",
  pending: "bg-chart-4 text-white",
  overdue: "bg-destructive text-destructive-foreground",
};

export default function ContactsInvoices({ contacts, invoices, onAddContact, onEditContact, onAddInvoice, onViewInvoice }: ContactsInvoicesProps) {
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
          {contacts.map((contact) => (
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
        <div className="flex justify-end mb-4">
          <Button onClick={onAddInvoice} data-testid="button-add-invoice">
            Add Invoice
          </Button>
        </div>
        <div className="space-y-4">
          {invoices.map((invoice) => (
            <Card key={invoice.id} className="hover-elevate" data-testid={`card-invoice-${invoice.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <h4 className="font-semibold text-base" data-testid={`text-invoice-vendor-${invoice.id}`}>
                          {invoice.vendor}
                        </h4>
                        <p className="text-sm text-muted-foreground">{invoice.service}</p>
                      </div>
                      <Badge className={statusColors[invoice.status]} data-testid={`badge-invoice-status-${invoice.id}`}>
                        {invoice.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-4 mt-3 text-sm">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span>{invoice.invoiceNumber}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">${invoice.amount.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>Due {invoice.dueDate.toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => onViewInvoice?.(invoice.id)}
                    data-testid={`button-view-invoice-${invoice.id}`}
                  >
                    View
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}
