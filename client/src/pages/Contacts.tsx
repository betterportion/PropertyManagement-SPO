import { useState } from "react";
import ContactsInvoices from "@/components/ContactsInvoices";
import RegionSelector from "@/components/RegionSelector";
import BuildingSelector from "@/components/BuildingSelector";

export default function Contacts() {
  //todo: remove mock functionality
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [selectedBuilding, setSelectedBuilding] = useState("all");

  const buildings = [
    { id: "1", address: "123 Main St, Austin, TX" },
    { id: "2", address: "456 Oak Ave, Austin, TX" },
    { id: "3", address: "789 River Rd, Austin, TX" },
    { id: "4", address: "321 Park Blvd, Austin, TX" },
    { id: "5", address: "654 Elm St, Austin, TX" },
  ];

  const allContacts = [
    {
      id: "1",
      name: "John Smith",
      company: "ABC Plumbing Services",
      service: "Plumbing",
      phone: "(512) 555-0123",
      email: "john@abcplumbing.com",
      region: "west-central" as const,
      buildingId: "1",
    },
    {
      id: "2",
      name: "Sarah Williams",
      company: "Elite HVAC",
      service: "HVAC",
      phone: "(512) 555-0456",
      email: "sarah@elitehvac.com",
      region: "east-central" as const,
      buildingId: "2",
    },
    {
      id: "3",
      name: "David Martinez",
      company: "Bright Electric Co.",
      service: "Electrical",
      phone: "(512) 555-0789",
      email: "david@brightelectric.com",
      region: "north-west" as const,
      buildingId: "3",
    },
    {
      id: "4",
      name: "Lisa Anderson",
      company: "Premier Landscaping",
      service: "Landscaping",
      phone: "(512) 555-0321",
      email: "lisa@premierlandscape.com",
      region: "south-west" as const,
      buildingId: "4",
    },
    {
      id: "5",
      name: "Robert Taylor",
      company: "Quick Fix Appliances",
      service: "Appliance Repair",
      phone: "(512) 555-0998",
      email: "robert@quickfix.com",
      region: "north-east" as const,
      buildingId: "5",
    },
    {
      id: "6",
      name: "Jennifer Lee",
      company: "Ace Carpentry",
      service: "Carpentry",
      phone: "(512) 555-0775",
      email: "jennifer@acecarp.com",
      region: "south-east" as const,
      buildingId: "1",
    },
  ];

  const allInvoices = [
    {
      id: "1",
      vendor: "ABC Plumbing Services",
      service: "Emergency pipe repair",
      amount: 850,
      dueDate: new Date(2025, 10, 20),
      status: "pending" as const,
      invoiceNumber: "INV-2025-001",
      region: "west-central" as const,
      buildingId: "1",
    },
    {
      id: "2",
      vendor: "Elite HVAC",
      service: "Annual maintenance",
      amount: 1200,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
      invoiceNumber: "INV-2025-002",
      region: "east-central" as const,
      buildingId: "2",
    },
    {
      id: "3",
      vendor: "Bright Electric Co.",
      service: "Outlet installation",
      amount: 450,
      dueDate: new Date(2025, 10, 15),
      status: "pending" as const,
      invoiceNumber: "INV-2025-003",
      region: "north-west" as const,
      buildingId: "3",
    },
    {
      id: "4",
      vendor: "Premier Landscaping",
      service: "Monthly service",
      amount: 600,
      dueDate: new Date(2025, 9, 30),
      status: "overdue" as const,
      invoiceNumber: "INV-2025-004",
      region: "south-west" as const,
      buildingId: "4",
    },
    {
      id: "5",
      vendor: "Quick Fix Appliances",
      service: "Refrigerator repair",
      amount: 325,
      dueDate: new Date(2025, 10, 18),
      status: "pending" as const,
      invoiceNumber: "INV-2025-005",
      region: "north-east" as const,
      buildingId: "5",
    },
    {
      id: "6",
      vendor: "Ace Carpentry",
      service: "Door installation",
      amount: 950,
      dueDate: new Date(2025, 10, 5),
      status: "paid" as const,
      invoiceNumber: "INV-2025-006",
      region: "south-east" as const,
      buildingId: "1",
    },
  ];

  const contacts = allContacts.filter((contact) => {
    const matchesRegion = selectedRegion === "all" || contact.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || contact.buildingId === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  const invoices = allInvoices.filter((invoice) => {
    const matchesRegion = selectedRegion === "all" || invoice.region === selectedRegion;
    const matchesBuilding = selectedBuilding === "all" || invoice.buildingId === selectedBuilding;
    return matchesRegion && matchesBuilding;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Contacts & Invoices</h1>
        <p className="text-muted-foreground mt-1">Manage maintenance contacts and track invoices</p>
      </div>

      <div className="flex flex-wrap gap-4">
        <RegionSelector
          selectedRegion={selectedRegion}
          onRegionChange={setSelectedRegion}
        />
        <BuildingSelector
          selectedBuilding={selectedBuilding}
          onBuildingChange={setSelectedBuilding}
          buildings={buildings}
        />
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
