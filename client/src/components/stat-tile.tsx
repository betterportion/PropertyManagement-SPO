import { Card, CardContent } from "@/components/ui/card";
import { StatPlaceholder } from "@/components/states";
import { cn } from "@/lib/utils";

/**
 * The single statistic tile used across dashboards and list pages —
 * §6 of the SPO design system.
 *
 * While a number is still loading it shows an em-dash placeholder, never a
 * spinner and never a misleading zero.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  isLoading,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  isLoading?: boolean;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </div>
        <p
          className="mt-2 text-3xl font-semibold tabular-nums tracking-tight"
          data-testid={`stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        >
          {isLoading ? <StatPlaceholder /> : value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Responsive row of stat tiles. Four across on desktop, two on tablet. */
export function StatGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)} {...props} />
  );
}
