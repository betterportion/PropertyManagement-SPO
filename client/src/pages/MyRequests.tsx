import { useQuery } from "@tanstack/react-query";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MaintenanceRequest } from "@shared/schema";
import { Section, Container, PageHeader, PageStack } from "@/components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Wrench } from "lucide-react";

export default function MyRequests() {
  const { data: requests = [], isLoading, isError, refetch } = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });

  const activeRequests = requests.filter((r) => r.status !== "completed" && r.status !== "cancelled");
  const completedRequests = requests.filter((r) => r.status === "completed" || r.status === "cancelled");

  if (isLoading) {
    return <Section><Container><PageStack><PageHeader title="My requests" description="Track updates from the property team." /><LoadingState message="Loading your requests..." /></PageStack></Container></Section>;
  }

  return (
    <Section><Container><PageStack>
      <PageHeader title="My requests" description="Track updates from the property team." actions={<Link href="/submit-request"><Button variant="primary"><Wrench /> Submit a request</Button></Link>} />
      {isError && <ErrorState onRetry={() => refetch()} />}

      <Tabs defaultValue="active" data-testid="tabs-my-requests">
        <TabsList>
          <TabsTrigger value="active" data-testid="tab-active-requests">
            Active ({activeRequests.length})
          </TabsTrigger>
          <TabsTrigger value="completed" data-testid="tab-completed-requests">
            Completed ({completedRequests.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="space-y-4 mt-6">
          {activeRequests.length === 0 ? (
            <EmptyState icon={Wrench} title="Nothing needs attention right now" description="New maintenance requests will appear here as soon as you submit them." action={<Link href="/submit-request"><Button variant="secondary">Submit a request</Button></Link>} />
          ) : (
            activeRequests.map((request) => (
              <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
            ))
          )}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4 mt-6">
          {completedRequests.length === 0 ? (
            <EmptyState title="Your completed requests will appear here" description="Resolved and cancelled requests stay here so you can refer back to them." />
          ) : (
            completedRequests.map((request) => (
              <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
            ))
          )}
        </TabsContent>
      </Tabs>
    </PageStack></Container></Section>
  );
}
