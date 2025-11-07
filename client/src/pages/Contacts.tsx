import ContactsInvoices from "@/components/ContactsInvoices";

export default function Contacts() {
  //todo: remove mock functionality
  const contacts = [
    {
      id: "1",
      name: "John Smith",
      company: "ABC Plumbing Services",
      service: "Plumbing",
      phone: "(512) 555-0123",
      email: "john@abcplumbing.com",
    },
    {
      id: "2",
      name: "Sarah Williams",
      company: "Elite HVAC",
      service: "HVAC",
      phone: "(512) 555-0456",
      email: "sarah@elitehvac.com",
    },
    {
      id: "3",
      name: "David Martinez",
      company: "Bright Electric Co.",
      service: "Electrical",
      phone: "(512) 555-0789",
      email: "david@brightelectric.com",
    },
    {
      id: "4",
      name: "Lisa Anderson",
      company: "Premier Landscaping",
      service: "Landscaping",
      phone: "(512) 555-0321",
      email: "lisa@premierlandscape.com",
    },
  ];

  const invoices = [
    {
      id: "1",
      vendor: "ABC Plumbing Services",
      service: "Emergency pipe repair",
      amount: 850,
      dueDate: new Date(2025, 10, 20),
      status: "pending" as const,
      invoiceNumber: "INV-2025-001",
    },
    {
      id: "2",
      vendor: "Elite HVAC",
      service: "Annual maintenance",
      amount: 1200,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
      invoiceNumber: "INV-2025-002",
    },
    {
      id: "3",
      vendor: "Bright Electric Co.",
      service: "Outlet installation",
      amount: 450,
      dueDate: new Date(2025, 10, 15),
      status: "pending" as const,
      invoiceNumber: "INV-2025-003",
    },
    {
      id: "4",
      vendor: "Premier Landscaping",
      service: "Monthly service",
      amount: 600,
      dueDate: new Date(2025, 9, 30),
      status: "overdue" as const,
      invoiceNumber: "INV-2025-004",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Contacts & Invoices</h1>
        <p className="text-muted-foreground mt-1">Manage maintenance contacts and track invoices</p>
      </div>

      <ContactsInvoices
        contacts={contacts}
        invoices={invoices}
        onAddContact={() => console.log("Add contact")}
        onAddInvoice={() => console.log("Add invoice")}
        onViewInvoice={(id) => console.log("View invoice:", id)}
      />
    </div>
  );
}
