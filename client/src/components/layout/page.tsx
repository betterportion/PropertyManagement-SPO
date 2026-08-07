import { cn } from "@/lib/utils";

/**
 * Page composition primitives — §6 of the SPO design system.
 *
 * Every page reads the same way:
 *
 *   <Section>
 *     <Container>
 *       <PageHeader title="Maintenance" description="Track and resolve requests." />
 *       ... cards, tables, filters ...
 *     </Container>
 *   </Section>
 */

export function Section({
  className,
  size = "default",
  ...props
}: React.HTMLAttributes<HTMLElement> & { size?: "default" | "compact" | "lg" }) {
  return (
    <section
      className={cn(
        size === "compact" && "py-6 md:py-8",
        size === "default" && "py-12 md:py-16",
        size === "lg" && "py-16 md:py-20",
        className,
      )}
      {...props}
    />
  );
}

export function Container({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8", className)} {...props} />
  );
}

/** The title + muted one-line description block that opens every page. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  /** Page-level actions, right-aligned on wide screens. At most one solid `primary` button. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Standard vertical rhythm for the contents of a page. */
export function PageStack({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-6", className)} {...props} />;
}
