import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-request-photos"] });
      toast({ title: "Request submitted", description: "You'll find it under My requests." });
      setLocation("/my-requests");
    },
    onError: (error: Error) => {
      // apiRequest throws "<status>: <body>"; the body is JSON like
      // {"message":"..."}. Surface the server's message — it explains the one
      // expected failure, not being on a house roster yet.
      const body = error.message.replace(/^\d+:\s*/, "");
      let message = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.message) message = parsed.message;
      } catch {
        // Not JSON; use the raw text.
      }
      toast({
        title: "Couldn't submit the request",
        description: message || "Please try again.",
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
