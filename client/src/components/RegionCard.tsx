import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { isAllClear, scoreCountsHidden } from "@/lib/regionCard";

export interface RegionSummary {
  region: string;
  admins: { name: string; email: string | null }[];
  openRequests: number;
  openRepairs: number;
  openJobs: number;
  safetyPreventiveDue: number;
  leaseRenewalsDue: number;
  unpaidRent: { count: number; amount: string };
  attentionScore: number;
  hidden: string[];
}

function Metric({ label, value }: { label: string; value: number }) {
  const attention = value > 0;
  return (
    <div>
      <p className={`text-2xl font-semibold tabular-nums ${attention ? "text-foreground" : "text-muted-foreground"}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground leading-tight">{label}</p>
    </div>
  );
}

/**
 * One region's health at a glance for the leadership overview: who runs it and
 * the three operational counts that make up its attention score. Rendered as a
 * button so it is keyboard-focusable and drills into that region on click.
 *
 * "All clear" is shown only when the score is zero and none of its sources
 * is hidden -- a score source hidden by a missing permission reads as a
 * plain-language note instead, never as clear. Hidden rent does not count:
 * rent is never part of the score (see `lib/regionCard.ts`).
 */
export default function RegionCard({ summary, onSelect }: { summary: RegionSummary; onSelect: () => void }) {
  const leads = summary.admins.map((a) => a.name).join(", ");
  const needsAttention = summary.attentionScore > 0;
  const allClear = isAllClear(summary);
  const scoreHidden = scoreCountsHidden(summary.hidden);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`View ${summary.region}`}
      className="text-left w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`card-region-${summary.region}`}
    >
      <Card className="hover-elevate h-full">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold">{summary.region}</h3>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {leads || "No regional admin assigned"}
              </p>
            </div>
            {needsAttention ? (
              <Badge variant="warning">Needs attention</Badge>
            ) : allClear ? (
              <Badge variant="secondary">All clear</Badge>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric label="Safety / preventive" value={summary.safetyPreventiveDue} />
            <Metric label="Open requests" value={summary.openRequests} />
            <Metric label="Renewals due" value={summary.leaseRenewalsDue} />
          </div>

          {summary.unpaidRent.count > 0 && (
            <p className="text-xs text-muted-foreground">
              {summary.unpaidRent.count} behind on HH fees · {formatCurrency(summary.unpaidRent.amount)} outstanding
            </p>
          )}

          {scoreHidden && (
            <p className="text-xs text-muted-foreground" data-testid={`text-region-hidden-${summary.region}`}>
              Some counts are hidden — you don't have permission to see all of this region's data.
            </p>
          )}
        </CardContent>
      </Card>
    </button>
  );
}
