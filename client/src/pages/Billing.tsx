import { useState } from "react";
import ResidentBilling from "@/components/ResidentBilling";
import RegionSelector from "@/components/RegionSelector";

export default function Billing() {
  //todo: remove mock functionality
  const [selectedRegion, setSelectedRegion] = useState("all");

  const allResidents = [
    {
      id: "1",
      name: "Sarah Johnson",
      unit: "Unit 204",
      email: "sarah.j@email.com",
      phone: "(512) 555-0189",
      moveInDate: new Date(2024, 5, 1),
      rentAmount: 1850,
      region: "west-central" as const,
    },
    {
      id: "2",
      name: "Michael Chen",
      unit: "Unit 305",
      email: "mchen@email.com",
      phone: "(512) 555-0234",
      moveInDate: new Date(2024, 2, 15),
      rentAmount: 2100,
      region: "east-central" as const,
    },
    {
      id: "3",
      name: "Emma Wilson",
      unit: "Unit 101",
      email: "emma.w@email.com",
      phone: "(512) 555-0567",
      moveInDate: new Date(2024, 8, 1),
      rentAmount: 1950,
      region: "north-west" as const,
    },
    {
      id: "4",
      name: "David Brown",
      unit: "Unit 402",
      email: "dbrown@email.com",
      phone: "(512) 555-0890",
      moveInDate: new Date(2024, 3, 10),
      rentAmount: 2200,
      region: "south-west" as const,
    },
    {
      id: "5",
      name: "Lisa Martinez",
      unit: "Unit 501",
      email: "lmartinez@email.com",
      phone: "(512) 555-0678",
      moveInDate: new Date(2024, 7, 20),
      rentAmount: 1900,
      region: "north-east" as const,
    },
    {
      id: "6",
      name: "Tom Anderson",
      unit: "Unit 603",
      email: "tanderson@email.com",
      phone: "(512) 555-0445",
      moveInDate: new Date(2024, 1, 5),
      rentAmount: 2050,
      region: "south-east" as const,
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
    {
      id: "6",
      residentId: "4",
      description: "November Rent",
      amount: 2200,
      dueDate: new Date(2025, 10, 1),
      status: "paid" as const,
    },
  ];

  const residents = selectedRegion === "all" 
    ? allResidents 
    : allResidents.filter(resident => resident.region === selectedRegion);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Resident Billing</h1>
        <p className="text-muted-foreground mt-1">Manage resident information and billing records</p>
      </div>

      <RegionSelector
        selectedRegion={selectedRegion}
        onRegionChange={setSelectedRegion}
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
