import ResidentBilling from "../ResidentBilling";

export default function ResidentBillingExample() {
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
  ];

  return (
    <ResidentBilling 
      residents={residents}
      billingRecords={billingRecords}
      onAddBilling={(id) => console.log("Add billing for:", id)}
      onViewResident={(id) => console.log("View resident:", id)}
    />
  );
}
