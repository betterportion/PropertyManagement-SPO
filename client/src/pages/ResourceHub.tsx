import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { BookOpen, ClipboardList, ExternalLink, Home, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency, formatDate } from "@/lib/format";
import { canFillInWalkthroughs, type WalkthroughUser } from "@/lib/walkthrough";
import type { PropertyBudget, ResourceLink, Walkthrough } from "@shared/schema";

/**
 * The one page a household leader or steward needs to go to.
 *
 * The framing matters and it shapes the layout: for many students this is one
 * of their few interactions with SPO as an organisation, so it should read as
 * professional and relational rather than as an admin console with the
 * controls removed.
 *
 * Two halves. The **global** links are what SPO publishes for every house
 * (expectations, deep clean, renter's insurance, conduct, safety guidance),
 * managed in admin settings. The **property-specific** block is theirs: their
 * walkthrough, their maintenance requests, their startup budget.
 *
 * Most of the content lives on Drive and is **linked, never duplicated** — two
 * copies of a deep-clean checklist disagree within a term.
 *
 * **No financial information here.** A startup budget is an operating figure —
 * what the house has to furnish and settle itself — and is not deposit or rent
 * data, which residents never see anywhere in the portal.
 */

/** An icon per category, falling back to something neutral. */
const CATEGORY_ICON: Record<string, typeof BookOpen> = {
  Housekeeping: Home,
  Safety: Wrench,
  General: BookOpen,
};

export default function ResourceHub() {
  const { user } = useAuth();

  const { data: links = [], isLoading } = useQuery<ResourceLink[]>({
    queryKey: ["/api/resource-links"],
  });

  // Their own house's figure. The server narrows this by property, so there is
  // no filtering to get wrong here.
  const { data: budgets = [] } = useQuery<PropertyBudget[]>({
    queryKey: ["/api/property-budgets"],
  });

  const typedUser = user as (WalkthroughUser & { firstName?: string | null }) | null;
  const canWalk = canFillInWalkthroughs(typedUser);

  // Only fetched for somebody who can actually open one; the server scopes it
  // to their house either way.
  const { data: walkthroughs = [] } = useQuery<Walkthrough[]>({
    queryKey: ["/api/walkthroughs"],
    enabled: canWalk,
  });

  const currentWalkthrough = useMemo(() => {
    return [...walkthroughs].sort(
      (a, b) => new Date(b.walkthroughDate).getTime() - new Date(a.walkthroughDate).getTime(),
    )[0];
  }, [walkthroughs]);

  const thisYear = new Date().getFullYear();
  const budget =
    budgets.find((row) => row.year === thisYear) ??
    [...budgets].sort((a, b) => b.year - a.year)[0];

  /** Grouped by category so the page reads as sections rather than a list. */
  const byCategory = useMemo(() => {
    const groups = new Map<string, ResourceLink[]>();
    for (const link of links) {
      const existing = groups.get(link.category);
      if (existing) existing.push(link);
      else groups.set(link.category, [link]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [links]);

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title={typedUser?.firstName ? `Hello, ${typedUser.firstName}` : "Your house"}
            description="Everything you need for living in an SPO house, in one place."
          />

          {/* Theirs first. The general SPO material is below it, because what
              somebody comes here for is usually their own house. */}
          <Card>
            <CardHeader>
              <CardTitle>Your house</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {canWalk && (
                <Button variant="secondary" className="justify-start" asChild>
                  <Link
                    href={currentWalkthrough ? `/walkthroughs/${currentWalkthrough.id}` : "/walkthroughs"}
                    data-testid="link-hub-walkthrough"
                  >
                    <ClipboardList className="h-4 w-4" />
                    {currentWalkthrough
                      ? `Your walkthrough — ${formatDate(currentWalkthrough.walkthroughDate)}`
                      : "Your walkthroughs"}
                  </Link>
                </Button>
              )}

              <Button variant="secondary" className="justify-start" asChild>
                <Link href="/my-requests" data-testid="link-hub-requests">
                  <Wrench className="h-4 w-4" />
                  Your maintenance requests
                </Link>
              </Button>

              <Button variant="secondary" className="justify-start" asChild>
                <Link href="/submit-request" data-testid="link-hub-submit">
                  <Wrench className="h-4 w-4" />
                  Report something broken
                </Link>
              </Button>

              {budget && (
                <div
                  className="rounded-md border border-border p-3 sm:col-span-2"
                  data-testid="card-hub-budget"
                >
                  <p className="text-sm font-medium">
                    Startup budget {budget.year}: {formatCurrency(budget.amount)}
                  </p>
                  {budget.notes && (
                    <p className="mt-1 text-sm text-muted-foreground">{budget.notes}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    What the house has to get set up. Talk to your RA before spending it.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {isLoading ? (
            <LoadingState message="Loading your resources..." />
          ) : byCategory.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="Nothing has been published here yet"
              description="Your RA will add the house expectations, the deep clean checklist and the safety guidance here."
            />
          ) : (
            byCategory.map(([category, categoryLinks]) => {
              const Icon = CATEGORY_ICON[category] ?? BookOpen;
              return (
                <Card key={category} data-testid={`card-hub-category-${category}`}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                      {category}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {categoryLinks.map((link) => (
                      <a
                        key={link.id}
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-start gap-3 rounded-md border-b border-border py-3 last:border-b-0 hover:underline"
                        data-testid={`link-resource-${link.id}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{link.title}</span>
                          {link.description && (
                            <span className="block text-sm text-muted-foreground">
                              {link.description}
                            </span>
                          )}
                        </span>
                        {link.region && (
                          <Badge variant="secondary" className="shrink-0">
                            {link.region}
                          </Badge>
                        )}
                        <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                      </a>
                    ))}
                  </CardContent>
                </Card>
              );
            })
          )}
        </PageStack>
      </Container>
    </Section>
  );
}
