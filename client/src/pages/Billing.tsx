import { useState } from "react";
import ResidentBilling from "@/components/ResidentBilling";
import PropertySelector from "@/components/PropertySelector";

export default function Billing() {
  //todo: remove mock functionality
  const [selectedProperty, setSelectedProperty] = useState("1");

  const properties = [
    { id: "1", name: "Sunset Apartments", address: "123 Main St, Austin, TX" },
    { id: "2", name: "Oak Ridge Complex", address: "456 Oak Ave, Austin, TX" },
    { id: "3", name: "River View Condos", address: "789 River Rd, Austin, TX" },
  ];

  const residents = [
    {
      id: "1",
      name: "Sarah Johnson",
      unit: "Unit 204",
      email: "sarah.j@email.com",
      phone: "(512) 555-0189",
      moveInDate: new Date(2024, 5, 1),
      rentAmount: 1850,
    },
    {
      id: "2",
      name: "Michael Chen",
      unit: "Unit 305",
      email: "mchen@email.com",
      phone: "(512) 555-0234",
      moveInDate: new Date(2024, 2, 15),
      rentAmount: 2100,
    },
    {
      id: "3",
      name: "Emma Wilson",
      unit: "Unit 101",
      email: "emma.w@email.com",
      phone: "(512) 555-0567",
      moveInDate: new Date(2024, 8, 1),
      rentAmount: 1950,
    },
  ];

  const billingRecords = [
    {
      id: "1",
      residentId: "1",
      description: "November Rent",
      amount: 1850,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
    },
    {
      id: "2",
      residentId: "1",
      description: "Late Fee",
      amount: 50,
      dueDate: new Date(2025, 10, 5),
      status: "pending" as const,
    },
    {
      id: "3",
      residentId: "2",
      description: "November Rent",
      amount: 2100,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
    },
    {
      id: "4",
      residentId: "2",
      description: "Parking Fee",
      amount: 100,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
    },
    {
      id: "5",
      residentId: "3",
      description: "November Rent",
      amount: 1950,
      dueDate: new Date(2025, 10, 1),
      status: "pending" as const,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Resident Billing</h1>
        <p className="text-muted-foreground mt-1">Manage resident information and billing records</p>
      </div>

      <PropertySelector
        selectedProperty={selectedProperty}
        onPropertyChange={setSelectedProperty}
        properties={properties}
      />

      <ResidentBilling
        residents={residents}
        billingRecords={billingRecords}
        onAddBilling={(id) => console.log("Add billing for:", id)}
        onViewResident={(id) => console.log("View resident:", id)}
      />
    </div>
  );
}
