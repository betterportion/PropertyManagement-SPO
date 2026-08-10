import MaintenanceRequestForm from "@/components/MaintenanceRequestForm";
import { useLocation } from "wouter";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";

export default function SubmitRequest() {
  const [, setLocation] = useLocation();
  const handleSubmit = (data: any) => {
    console.log("Submitting request:", data);
    setTimeout(() => {
      setLocation("/my-requests");
    }, 500);
  };

  return (
    <Section><Container><PageStack className="max-w-2xl">
      <PageHeader title="Submit a maintenance request" description="Tell us what needs attention and where to find it." />
      <MaintenanceRequestForm onSubmit={handleSubmit} />
    </PageStack></Container></Section>
  );
}
