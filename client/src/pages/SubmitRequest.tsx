import MaintenanceRequestForm from "@/components/MaintenanceRequestForm";
import { useLocation } from "wouter";

export default function SubmitRequest() {
  const [, setLocation] = useLocation();

  const handleSubmit = (data: any) => {
    console.log("Submitting request:", data);
    // In a real app, this would submit to the backend
    setTimeout(() => {
      setLocation("/my-requests");
    }, 500);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-semibold">Submit Maintenance Request</h1>
        <p className="text-muted-foreground mt-1">Let us know about any issues in your unit</p>
      </div>

      <MaintenanceRequestForm onSubmit={handleSubmit} />
    </div>
  );
}
