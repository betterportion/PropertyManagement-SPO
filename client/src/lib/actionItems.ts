/**
 * Client view of a dashboard action item and how to resolve one.
 *
 * The server (`server/actionItems.ts`) classifies each item; the client owns
 * the "resolve" request because it knows today's date. Money items ask for a
 * confirmation first — marking rent paid or a deposit returned changes a real,
 * audited record — while completing a maintenance check or a manual task is a
 * single click.
 */

// One definition, shared with the server. Keeping a second copy here is what
// let the `setup` and `asset` sources reach this switch without a case.
import type { ActionItemCategory, ActionItemSource } from "@shared/actionItems";

export type { ActionItemCategory, ActionItemSource };

export interface ActionItem {
  id: string;
  source: ActionItemSource;
  category: ActionItemCategory;
  title: string;
  subtitle: string;
  amount?: string | null;
  dueDate: string | null;
  overdue: boolean;
  region: string | null;
}

export interface ResolveRequest {
  /** The label on the row's button, e.g. "Mark paid" or "Review lease". */
  actionLabel: string;
  /**
   * A resolve is either an API call (method/path[/body], optionally confirmed)
   * or a navigation (href) when the item needs a fuller form to act on — a
   * lease renewal, say, where the RA records dates and a decision.
   */
  method?: "POST" | "PATCH";
  path?: string;
  body?: unknown;
  href?: string;
  /** When set, a confirm dialog with this copy runs before an API resolve. */
  confirm?: { title: string; body: string };
  /** Query keys to refetch after a successful API resolve. */
  invalidate?: string[];
}

/** Today as "YYYY-MM-DD", the shape the date columns accept from a form. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const ACTION_ITEMS_KEY = "/api/action-items";

export function resolveRequest(item: ActionItem): ResolveRequest {
  switch (item.source) {
    case "schedule":
      return {
        method: "POST",
        path: `/api/maintenance-schedules/${item.id}/complete`,
        actionLabel: "Mark done",
        invalidate: [ACTION_ITEMS_KEY, "/api/maintenance-schedules"],
      };
    case "rent":
      return {
        method: "PATCH",
        path: `/api/rent-payments/${item.id}`,
        body: { status: "paid", paidDate: today() },
        actionLabel: "Mark paid",
        confirm: {
          title: "Mark this rent as paid?",
          body: "This records the rent as paid today. You can adjust it later on the Finances page.",
        },
        invalidate: [ACTION_ITEMS_KEY, "/api/rent-payments"],
      };
    case "deposit":
      return {
        method: "PATCH",
        path: `/api/security-deposits/${item.id}`,
        body: { status: "returned", amountReturned: item.amount, returnedDate: today() },
        actionLabel: "Mark returned",
        confirm: {
          title: "Mark this deposit as returned?",
          body: "This records the full deposit as returned today. For a partial return or deductions, use the Finances page.",
        },
        invalidate: [ACTION_ITEMS_KEY, "/api/security-deposits"],
      };
    case "task":
      return {
        method: "PATCH",
        path: `/api/tasks/${item.id}`,
        body: { status: "done" },
        actionLabel: "Done",
        invalidate: [ACTION_ITEMS_KEY, "/api/tasks"],
      };
    case "lease":
      // A renewal needs dates and a decision, so send the RA to the property to
      // record it in the edit dialog rather than resolving in one click.
      return { actionLabel: "Review lease", href: "/properties" };
    case "setup":
      // Seven checks cannot be ticked by one button, and the id on a setup
      // item is the property's -- so this opens the house.
      return { actionLabel: "Open the checklist", href: `/properties/${item.id}` };
    case "asset":
      // Replacing something is a decision, not a click: the asset page is
      // where the date is corrected or the warning snoozed with a reason.
      return { actionLabel: "Open the asset", href: `/assets/${item.id}` };
    default:
      // A newer server can send a kind this client has never heard of. The
      // row degrades to a link rather than white-screening the page, which is
      // what an unguarded `undefined` from this switch used to do.
      return { actionLabel: "Open", href: "/" };
  }
}

/** A short human label for the item's category, for the row badge. */
export function categoryLabel(item: ActionItem): string {
  if (item.source === "lease") return "Lease";
  if (item.source === "setup") return "Setup";
  if (item.source === "asset") return "Asset";
  if (item.category === "safety") return "Safety";
  if (item.source === "task") return "Task";
  if (item.category === "finance") return "Finance";
  if (item.category === "property") return "Property";
  return "General";
}
