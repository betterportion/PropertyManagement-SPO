import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft, CheckCircle2, Camera, ChevronRight, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useUrlState } from "@/hooks/use-url-state";
import { formatDate } from "@/lib/format";
import {
  CONDITION_LABEL,
  WALKTHROUGH_TYPE_LABEL,
} from "@/lib/walkthrough";
import type { FlaggedWalkthroughItem } from "@shared/schema";

/**
 * Everything a walkthrough recorded as poor or damaged, across every house the
 * caller covers.
 *
 * The need this answers is specific: a deep hole in a wall should surface
 * without anybody opening walkthroughs one at a time. So the list is flat and
 * sorted newest-first, grouped only by house, and each row goes straight to
 * the room it came from.
 *
 * No summarising and no scoring — the server sends the items and this screen
 * shows them. Filters live in the URL so a link to "damaged items at 12 Elm
 * St" can be pasted into a message.
 */

/** Damage first: it is the thing somebody has to act on today. */
const CONDITION_ORDER: Record<string, number> = { damaged: 0, poor: 1 };

export default function FlaggedItems() {
  const [, navigate] = useLocation();
  const [filters, setFilters] = useUrlState({ house: "all", condition: "all" });

  const { data: items = [], isLoading } = useQuery<FlaggedWalkthroughItem[]>({
    queryKey: ["/api/walkthrough-flagged-items"],
  });

  /** The houses actually represented, so the filter never offers an empty option. */
  const houses = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) seen.add(item.buildingAddress);
    return Array.from(seen).sort();
  }, [items]);

  const visible = useMemo(() => {
    const filtered = items.filter(
      (item) =>
        (filters.house === "all" || item.buildingAddress === filters.house) &&
        (filters.condition === "all" || item.condition === filters.condition),
    );
    return filtered.sort((a, b) => {
      const byCondition =
        (CONDITION_ORDER[a.condition] ?? 9) - (CONDITION_ORDER[b.condition] ?? 9);
      if (byCondition !== 0) return byCondition;
      return new Date(b.walkthroughDate).getTime() - new Date(a.walkthroughDate).getTime();
    });
  }, [items, filters.house, filters.condition]);

  /** Rows keep their house heading so an RA reads a house at a time. */
  const grouped = useMemo(() => {
    const groups = new Map<string, FlaggedWalkthroughItem[]>();
    for (const item of visible) {
      const existing = groups.get(item.buildingAddress);
      if (existing) existing.push(item);
      else groups.set(item.buildingAddress, [item]);
    }
    return Array.from(groups.entries());
  }, [visible]);

  const damagedCount = visible.filter((item) => item.condition === "damaged").length;

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Needs attention"
            description="Every walkthrough item recorded poor or damaged, newest first."
            actions={
              <Button
                variant="ghost"
                onClick={() => navigate("/walkthroughs")}
                data-testid="button-back-to-walkthroughs"
              >
                <ArrowLeft className="h-4 w-4" />
                Walkthroughs
              </Button>
            }
          />

          <div className="flex flex-wrap items-center gap-3">
            <Select value={filters.house} onValueChange={(house) => setFilters({ house })}>
              <SelectTrigger className="w-64" data-testid="select-flagged-house">
                <SelectValue placeholder="Every house" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every house</SelectItem>
                {houses.map((house) => (
                  <SelectItem key={house} value={house}>
                    {house}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.condition}
              onValueChange={(condition) => setFilters({ condition })}
            >
              <SelectTrigger className="w-48" data-testid="select-flagged-condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Poor and damaged</SelectItem>
                <SelectItem value="damaged">Damaged only</SelectItem>
                <SelectItem value="poor">Poor only</SelectItem>
              </SelectContent>
            </Select>

            <p className="text-sm text-muted-foreground" data-testid="text-flagged-summary">
              {visible.length} item{visible.length === 1 ? "" : "s"}
              {damagedCount > 0 ? ` · ${damagedCount} damaged` : ""}
            </p>
          </div>

          {isLoading ? (
            <LoadingState message="Looking through the walkthroughs..." />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={items.length === 0 ? CheckCircle2 : TriangleAlert}
              title={
                items.length === 0
                  ? "Nothing is flagged right now"
                  : "Nothing matches these filters"
              }
              description={
                items.length === 0
                  ? "Every item checked so far came back fair or better. Anything recorded poor or damaged in a walkthrough shows up here."
                  : "Widen the house or condition filter to see the rest."
              }
            />
          ) : (
            <div className="space-y-8">
              {grouped.map(([house, houseItems]) => (
                <div key={house} className="space-y-3">
                  <div className="flex items-baseline gap-3">
                    <h2 className="text-lg font-semibold tracking-tight" data-testid={`text-flagged-house-${house}`}>
                      {house}
                    </h2>
                    <span className="text-sm text-muted-foreground">
                      {houseItems.length} item{houseItems.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {houseItems.map((item) => (
                      <Card
                        key={item.itemId}
                        className="cursor-pointer hover-elevate active-elevate-2"
                        onClick={() =>
                          navigate(`/walkthroughs/${item.walkthroughId}?room=${item.roomId}`)
                        }
                        data-testid={`card-flagged-item-${item.itemId}`}
                      >
                        <CardContent className="flex items-start gap-3 p-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant={item.condition === "damaged" ? "destructive" : "warning"}
                                data-testid={`badge-flagged-condition-${item.itemId}`}
                              >
                                {CONDITION_LABEL[item.condition]}
                              </Badge>
                              <p className="font-semibold" data-testid={`text-flagged-label-${item.itemId}`}>
                                {item.roomName} · {item.label}
                              </p>
                            </div>
                            {item.notes && (
                              <p className="mt-1 text-sm text-muted-foreground" data-testid={`text-flagged-notes-${item.itemId}`}>
                                {item.notes}
                              </p>
                            )}
                            <p className="mt-1 text-xs text-muted-foreground">
                              {WALKTHROUGH_TYPE_LABEL[item.walkthroughType]} walkthrough ·{" "}
                              {formatDate(item.walkthroughDate)}
                              {item.roomPhotoCount > 0 ? "" : " · no photo of this room"}
                            </p>
                          </div>
                          {item.roomPhotoCount > 0 && (
                            <span
                              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                              data-testid={`text-flagged-photos-${item.itemId}`}
                            >
                              <Camera className="h-3.5 w-3.5" />
                              {item.roomPhotoCount}
                            </span>
                          )}
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </PageStack>
      </Container>
    </Section>
  );
}
