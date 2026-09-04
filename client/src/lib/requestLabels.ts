/**
 * How a request's status and priority read on screen.
 *
 * One definition, because the request page and the property page's request
 * table both draw these badges, and two copies is how "In progress" on one
 * screen becomes "in_progress" on the other. Every state carries its word;
 * colour is a second signal and never the only one.
 */
import type { MaintenanceRequest } from "@shared/schema";

type BadgeVariant = "warning" | "info" | "success" | "secondary" | "destructive" | "orange";

export const REQUEST_STATUS: Record<MaintenanceRequest["status"], { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "warning" },
  in_progress: { label: "In progress", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

export const REQUEST_PRIORITY: Record<MaintenanceRequest["priority"], { label: string; variant: BadgeVariant }> = {
  low: { label: "Low", variant: "secondary" },
  medium: { label: "Medium", variant: "info" },
  high: { label: "High", variant: "orange" },
  urgent: { label: "Urgent", variant: "destructive" },
  wishlist: { label: "Wishlist", variant: "secondary" },
};
