import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, User } from "lucide-react";
import { format } from "date-fns";

interface MaintenanceRequest {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: "pending" | "in_progress" | "completed";
  submittedBy: string;
  submittedDate: Date;
  location: string;
}

interface MaintenanceRequestCardProps {
  request: MaintenanceRequest;
  onStatusChange?: (id: string, status: string) => void;
  isAdmin?: boolean;
}

const priorityColors = {
  low: "bg-secondary text-secondary-foreground",
  medium: "bg-chart-4 text-white",
  high: "bg-chart-5 text-white",
  urgent: "bg-destructive text-destructive-foreground",
};

const statusColors = {
  pending: "bg-muted text-muted-foreground",
  in_progress: "bg-chart-1 text-white",
  completed: "bg-chart-2 text-white",
};

export default function MaintenanceRequestCard({ request, onStatusChange, isAdmin = false }: MaintenanceRequestCardProps) {
  return (
    <Card className="hover-elevate" data-testid={`card-request-${request.id}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-base truncate" data-testid={`text-request-title-${request.id}`}>
            {request.title}
          </h3>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{request.location}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Badge className={priorityColors[request.priority]} data-testid={`badge-priority-${request.id}`}>
            {request.priority}
          </Badge>
          <Badge className={statusColors[request.status]} data-testid={`badge-status-${request.id}`}>
            {request.status.replace("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">{request.description}</p>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <User className="h-3 w-3" />
              <span>{request.submittedBy}</span>
            </div>
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              <span>{format(request.submittedDate, "MMM d, yyyy")}</span>
            </div>
          </div>
          {isAdmin && request.status !== "completed" && (
            <Button 
              size="sm" 
              variant="outline"
              onClick={() => onStatusChange?.(request.id, request.status === "pending" ? "in_progress" : "completed")}
              data-testid={`button-update-status-${request.id}`}
            >
              {request.status === "pending" ? "Start" : "Complete"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
