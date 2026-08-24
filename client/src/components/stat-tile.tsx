import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { StatPlaceholder } from "@/components/states";
import { cn } from "@/lib/utils";

/**
 * The single statistic tile used across dashboards and list pages —
 * §6 of the SPO design system.
 *
 * While a number is still loading it shows an em-dash placeholder, never a
 * spinner and never a misleading zero.
 *
 * With `href` the whole tile is a link to the page behind the number, with a
 * subtle hover glow so it reads as clickable.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  isLoading,
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  isLoading?: boolean;
  href?: string;
  className?: string;
}) {
  const tile = (
    <Card
      className={cn(
        href &&
          "h-full transition-shadow hover:shadow-md dark:hover:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_2px_16px_rgba(255,255,255,0.08)]",
        className,
      )}
    >
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

  if (!href) return tile;
  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      data-testid={`link-stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      {tile}
    </Link>
  );
}

/** Responsive row of stat tiles. Four across on desktop, two on tablet. */
export function StatGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)} {...props} />
  );
}
