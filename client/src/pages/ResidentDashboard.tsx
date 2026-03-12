import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Home, Wrench, Phone, Mail, MapPin } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import type { MaintenanceRequest } from "@shared/schema";

export default function ResidentDashboard() {
  const { user } = useAuth();
  const userData = user as any;
  const firstName = userData?.firstName || "Resident";

  const { data: requests = [] } = useQuery<MaintenanceRequest[]>({
    queryKey: ["/api/maintenance-requests"],
  });

  const activeRequests = requests.filter(
    (r) => r.status !== "completed" && r.status !== "cancelled"
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Welcome Back, {firstName}</h1>
        <p className="text-muted-foreground mt-1">Your maintenance dashboard</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5" />
              Property Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">Address</p>
                <p className="text-sm text-muted-foreground">Contact your property manager for details</p>
              </div>
            </div>
            <div className="pt-3 border-t">
              <p className="text-sm font-medium mb-2">Property Manager</p>
              <div className="space-y-2">
                <a
                  href="tel:5125550100"
                  className="flex items-center gap-2 text-sm hover-elevate active-elevate-2 p-2 rounded-md -ml-2"
                >
                  <Phone className="h-4 w-4" />
                  <span>(512) 555-0100</span>
                </a>
                <a
                  href="mailto:manager@sunsetapts.com"
                  className="flex items-center gap-2 text-sm hover-elevate active-elevate-2 p-2 rounded-md -ml-2"
                >
                  <Mail className="h-4 w-4" />
                  <span>manager@sunsetapts.com</span>
                </a>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              Quick Actions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link href="/submit-request">
              <Button className="w-full" data-testid="button-submit-maintenance">
                <Wrench className="h-4 w-4 mr-2" />
                Submit Maintenance Request
              </Button>
            </Link>
            <Link href="/my-requests">
              <Button variant="outline" className="w-full" data-testid="button-view-requests">
                View My Requests ({requests.length})
              </Button>
            </Link>
            <div className="pt-3 border-t">
              <p className="text-sm font-medium mb-2 text-destructive">Emergency Maintenance</p>
              <a href="tel:5125550911">
                <Button variant="destructive" className="w-full" data-testid="button-emergency">
                  <Phone className="h-4 w-4 mr-2" />
                  Call Emergency Line
                </Button>
              </a>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">My Active Requests</h2>
          <Link href="/my-requests">
            <Button variant="outline" size="sm" data-testid="button-view-all-my-requests">
              View All
            </Button>
          </Link>
        </div>
        <div className="space-y-4">
          {activeRequests.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active maintenance requests.</p>
          ) : (
            activeRequests.map((request) => (
              <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
