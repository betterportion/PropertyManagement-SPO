/**
 * Client view of a dashboard action item and how to resolve one.
 *
 * The server (`server/actionItems.ts`) classifies each item; the client owns
 * the "resolve" request because it knows today's date. Money items ask for a
 * confirmation first — marking rent paid or a deposit returned changes a real,
 * audited record — while completing a maintenance check or a manual task is a
 * single click.
 */

export type ActionItemSource = "schedule" | "rent" | "deposit" | "task";
export type ActionItemCategory = "property" | "finance" | "general";

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
  method: "POST" | "PATCH";
  path: string;
  body?: unknown;
  /** The label on the row's button, e.g. "Mark paid". */
  actionLabel: string;
  /** When set, a confirm dialog with this copy runs before the request. */
  confirm?: { title: string; body: string };
  /** Query keys to refetch after a successful resolve. */
  invalidate: string[];
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
  }
}

/** A short human label for the item's category, for the row badge. */
export function categoryLabel(item: ActionItem): string {
  if (item.source === "task") return "Task";
  if (item.category === "finance") return "Finance";
  if (item.category === "property") return "Property";
  return "General";
}
