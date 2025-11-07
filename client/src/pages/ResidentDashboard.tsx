import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import MaintenanceRequestCard from "@/components/MaintenanceRequestCard";
import { Home, Wrench, Phone, Mail, MapPin } from "lucide-react";
import { Link } from "wouter";

export default function ResidentDashboard() {
  //todo: remove mock functionality
  const myRequests = [
    {
      id: "1",
      title: "Leaking kitchen faucet",
      description: "The kitchen faucet has been dripping constantly for the past week.",
      category: "Plumbing",
      priority: "high" as const,
      status: "in_progress" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 10, 5),
      location: "Unit 204",
    },
    {
      id: "2",
      title: "Bedroom window won't close",
      description: "The window mechanism seems jammed.",
      category: "Structural",
      priority: "medium" as const,
      status: "pending" as const,
      submittedBy: "Sarah Johnson",
      submittedDate: new Date(2025, 10, 7),
      location: "Unit 204",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Welcome Back, Sarah</h1>
        <p className="text-muted-foreground mt-1">Unit 204 - Sunset Apartments</p>
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
                <p className="text-sm text-muted-foreground">123 Main St, Unit 204</p>
                <p className="text-sm text-muted-foreground">Austin, TX 78701</p>
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
                View My Requests ({myRequests.length})
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
          {myRequests.map((request) => (
            <MaintenanceRequestCard key={request.id} request={request} isAdmin={false} />
          ))}
        </div>
      </div>
    </div>
  );
}
