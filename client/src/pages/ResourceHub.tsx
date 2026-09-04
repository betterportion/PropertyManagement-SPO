import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { BookOpen, ClipboardList, ExternalLink, FileText, Home, KeyRound, Phone, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency, formatDate } from "@/lib/format";
import { canFillInWalkthroughs, type WalkthroughUser } from "@/lib/walkthrough";
import type { PropertyBudget, PropertyFacts, ResourceLink, Walkthrough } from "@shared/schema";
import { ACCESS_CODES, HOUSE_FACT_TEXT_FIELDS } from "@shared/houseFacts";

/**
 * What /api/my-property answers: a named-field projection of one house, never
 * the row. The facts are the household's block (ADR-0002); who to call and the
 * portal come from the property itself, and only for a house SPO rents.
 */
interface MyHouse {
  id: string;
  name: string;
  address: string;
  leaseDocumentUrl: string | null;
  maintenancePortalUrl: string | null;
  rentalCompany: { name: string; company: string; phone: string | null } | null;
  facts: Pick<
    PropertyFacts,
    | "doorCode"
    | "doorCodeUpdatedAt"
    | "gateCode"
    | "gateCodeUpdatedAt"
    | "alarmCode"
    | "alarmCodeUpdatedAt"
    | "securityNotes"
    | "parkingRules"
    | "surfaceCare"
    | "doNots"
    | "rubbishDay"
    | "otherNotes"
  > | null;
}

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

  // Their own house, for the lease link. A resident cannot read /api/properties
  // at all, so this comes from the one endpoint scoped to their house -- and an
  // account with no house link simply gets nothing rather than an error.
  const { data: house } = useQuery<MyHouse | null>({
    queryKey: ["/api/my-property"],
    retry: false,
  });

  // Codes and facts that are actually set; a blank one is not shown as a
  // blank. Nothing renders at all when staff have written nothing yet.
  const codes = ACCESS_CODES.filter((code) => house?.facts?.[code.key]);
  const textFacts = HOUSE_FACT_TEXT_FIELDS.filter((fact) => house?.facts?.[fact.key]);
  const whoToCall = house?.rentalCompany || house?.maintenancePortalUrl;
  const hasHouseBlock = codes.length > 0 || textFacts.length > 0 || Boolean(whoToCall);

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

              {house?.leaseDocumentUrl && (
                <Button variant="secondary" className="justify-start" asChild>
                  <a
                    href={house.leaseDocumentUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-testid="link-hub-lease"
                  >
                    <FileText className="h-4 w-4" />
                    Your lease
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              )}

              {hasHouseBlock && (
                <div
                  className="space-y-4 rounded-md border border-border p-3 sm:col-span-2"
                  data-testid="card-hub-house-facts"
                >
                  {codes.length > 0 && (
                    <dl className="grid gap-3 sm:grid-cols-3">
                      {codes.map((code) => (
                        <div key={code.key} data-testid={`fact-hub-${code.key}`}>
                          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                            <KeyRound className="h-3 w-3" />
                            {code.label}
                          </dt>
                          <dd className="mt-0.5 font-mono text-lg font-medium" data-testid={`text-hub-${code.key}`}>
                            {house?.facts?.[code.key]}
                          </dd>
                          {/* The date is there so somebody can ask whether it
                              should be changed -- a code three leaders old is
                              the failure this exists to catch. */}
                          <dd className="text-xs text-muted-foreground" data-testid={`text-hub-${code.key}-date`}>
                            {house?.facts?.[code.stamp]
                              ? `Last changed ${formatDate(house.facts[code.stamp])}`
                              : "No change recorded"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {textFacts.length > 0 && (
                    <dl className="grid gap-3 sm:grid-cols-2">
                      {textFacts.map((fact) => (
                        <div key={fact.key} data-testid={`fact-hub-${fact.key}`}>
                          <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                          <dd className="mt-0.5 whitespace-pre-line text-sm">{house?.facts?.[fact.key]}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {whoToCall && (
                    <div className="border-t border-border pt-3 text-sm" data-testid="fact-hub-who-to-call">
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        SPO rents this house. Repairs go to the rental company
                      </p>
                      {house?.rentalCompany && (
                        <p className="mt-0.5 font-medium">
                          {house.rentalCompany.company} — {house.rentalCompany.name}
                          {house.rentalCompany.phone && (
                            <span className="ml-2 font-normal text-muted-foreground">{house.rentalCompany.phone}</span>
                          )}
                        </p>
                      )}
                      {house?.maintenancePortalUrl && (
                        <a
                          href={house.maintenancePortalUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-1 inline-flex items-center gap-1 underline underline-offset-2"
                          data-testid="link-hub-maintenance-portal"
                        >
                          Their maintenance portal
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

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
