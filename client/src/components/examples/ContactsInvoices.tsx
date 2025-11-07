import ContactsInvoices from "../ContactsInvoices";

export default function ContactsInvoicesExample() {
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
  ];

  return (
    <ContactsInvoices 
      contacts={contacts}
      invoices={invoices}
      onAddContact={() => console.log("Add contact")}
      onAddInvoice={() => console.log("Add invoice")}
      onViewInvoice={(id) => console.log("View invoice:", id)}
    />
  );
}
