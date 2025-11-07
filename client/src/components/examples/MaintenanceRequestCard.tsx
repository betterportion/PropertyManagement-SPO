import MaintenanceRequestCard from "../MaintenanceRequestCard";

export default function MaintenanceRequestCardExample() {
  const request = {
    id: "1",
    title: "Leaking kitchen faucet",
    description: "The kitchen faucet has been dripping constantly for the past week. Water is pooling under the sink.",
    category: "Plumbing",
    priority: "high" as const,
    status: "pending" as const,
    submittedBy: "Sarah Johnson",
    submittedDate: new Date(2025, 10, 5),
    location: "Unit 204",
  };

  return (
    <MaintenanceRequestCard 
      request={request} 
      isAdmin={true}
      onStatusChange={(id, status) => console.log(`Update request ${id} to ${status}`)}
    />
  );
}
