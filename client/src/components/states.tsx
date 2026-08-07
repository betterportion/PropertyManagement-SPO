import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Shared loading / empty / error treatments — §7 of the SPO design system.
 * These are the moments users see most, so they look the same on every page.
 */

export function LoadingState({
  message = "Loading...",
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex h-64 items-center justify-center text-muted-foreground", className)}
      role="status"
      data-testid="state-loading"
    >
      {message}
    </div>
  );
}

/** Placeholder for a statistic that has not loaded yet. Never a spinner, never a zero. */
export function StatPlaceholder() {
  return <span className="text-muted-foreground">--</span>;
}

/**
 * Empty state. Copy must be positive and specific — say what it means, e.g.
 * "No open requests. Everything reported so far has been resolved."
 * Never "No data".
 */
export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("py-8 text-center text-muted-foreground", className)} data-testid="state-empty">
      {Icon && <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />}
      <p className="font-medium text-foreground">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-prose text-sm">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Inline error panel for a failed load inside a page or card. */
export function ErrorState({
  message = "Something went wrong loading this. Please try again.",
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-destructive",
        className,
      )}
      role="alert"
      data-testid="state-error"
    >
      <p className="text-sm">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
