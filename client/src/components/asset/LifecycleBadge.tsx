import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { assetLifecycle, type LifecycleStatus } from "@shared/assetLifecycle";
import type { Asset } from "@shared/schema";

/**
 * Where an asset stands in its life, as a badge.
 *
 * Two rules from the design conventions and the plan, both load-bearing:
 *
 *   - **Status is never colour alone.** Every badge carries its word. Somebody
 *     who cannot separate amber from red still reads "Due within a year".
 *   - **An unrated asset is not a warning.** SPO's tracking is patchy, and an
 *     asset with no acquisition date says so plainly rather than being guessed
 *     into a colour it has not earned.
 *
 * A snooze is shown beside the status, never instead of it. A snoozed boiler
 * is still overdue; somebody has simply said "not this year".
 */

const VARIANT: Record<LifecycleStatus, "secondary" | "success" | "warning" | "destructive"> = {
  unrated: "secondary",
  ok: "success",
  due_soon: "warning",
  urgent: "destructive",
  overdue: "destructive",
};

export default function LifecycleBadge({
  asset,
  showDate = false,
}: {
  asset: Asset;
  showDate?: boolean;
}) {
  const lifecycle = assetLifecycle(asset);

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={VARIANT[lifecycle.status]} data-testid={`badge-lifecycle-${asset.id}`}>
        {lifecycle.label}
      </Badge>

      {showDate && lifecycle.dueDate && (
        <span className="text-xs text-muted-foreground" data-testid={`text-lifecycle-due-${asset.id}`}>
          {formatDate(lifecycle.dueDate)}
        </span>
      )}

      {lifecycle.snoozed && (
        <Badge variant="outline" data-testid={`badge-snoozed-${asset.id}`}>
          Snoozed to {formatDate(asset.snoozedUntil)}
        </Badge>
      )}
    </span>
  );
}
