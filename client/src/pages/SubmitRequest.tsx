import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { serverMessage } from "@/lib/serverMessage";
import MaintenanceRequestForm from "@/components/MaintenanceRequestForm";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";

export default function SubmitRequest() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const createMutation = useMutation({
    // The region and house are attached server-side from the resident's roster
    // record, so the form only sends what the resident actually knows.
    mutationFn: async (data: {
      title: string;
      description: string;
      category: string;
      priority: string;
      location: string;
      photoUrls?: string[];
    }) => apiRequest("POST", "/api/maintenance-requests", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-requests"] });
      // The Patterns tab rolls up requests and contractor links; nothing refetches on its own.
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-aggregates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-request-photos"] });
      toast({ title: "Request submitted", description: "You'll find it under My requests." });
      setLocation("/my-requests");
    },
    onError: (error: Error) => {
      // The server's own words: field reasons first, then its message. The one
      // expected failure is not being on a house roster yet, and the route says so.
      toast({
        title: "Couldn't submit the request",
        description: serverMessage(error) ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <Section><Container><PageStack className="max-w-2xl">
      <PageHeader title="Submit a maintenance request" description="Tell us what needs attention and where to find it." />
      <MaintenanceRequestForm
        onSubmit={(data) => createMutation.mutate(data)}
        isSubmitting={createMutation.isPending}
      />
    </PageStack></Container></Section>
  );
}
