import { Link } from "wouter";
import { ClipboardList } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";
import { formatDate } from "@/lib/format";
import { groupOpenWork, type OpenWorkKey } from "@/lib/maintenanceFilters";
import { REQUEST_STATUS, REQUEST_TYPE } from "@/lib/requestLabels";
import type { MaintenanceRequest } from "@shared/schema";

/**
 * Open work on one house: everything not yet closed, grouped once.
 *
 * The grouping is `groupOpenWork` over the request list the property page
 * already fetches -- nothing here asks the server anything. Four groups,
 * always all four: an empty group says so rather than vanishing, because "no
 * projects open" is a fact about the house and a group that disappeared would
 * read as a page that forgot to load.
 */
const EMPTY: Record<OpenWorkKey, string> = {
  request: "No repairs open",
  project: "No projects open",
  capex: "No capital projects open",
  wishlist: "Nothing on the wishlist",
};

export default function PropertyOpenWork({
  requests,
  isLoading,
}: {
  requests: MaintenanceRequest[];
  isLoading: boolean;
}) {
  const groups = groupOpenWork(requests);
  const total = groups.reduce((n, group) => n + group.items.length, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          Open work
        </CardTitle>
        <span className="text-sm text-muted-foreground" data-testid="open-work-total">
          {total === 1 ? "1 item" : `${total} items`}
        </span>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState />
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {groups.map((group) => (
              <section
                key={group.key}
                aria-labelledby={`open-work-heading-${group.key}`}
                data-testid={`open-work-group-${group.key}`}
              >
                <h3
                  id={`open-work-heading-${group.key}`}
                  className="flex items-center gap-2 text-sm font-medium"
                >
                  {group.label}
                  <Badge variant="secondary" data-testid={`open-work-count-${group.key}`}>
                    {group.items.length}
                  </Badge>
                </h3>
                {group.items.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">{EMPTY[group.key]}</p>
                ) : (
                  <ul className="mt-1 divide-y divide-border">
                    {group.items.map((request) => (
                      <li
                        key={request.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                      >
                        <Link
                          href={`/maintenance/${request.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                          data-testid={`open-work-item-${request.id}`}
                        >
                          {request.title}
                        </Link>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {/* A wishlist item keeps its kind on its badge: a
                              wishlist capital project is still a capital project. */}
                          {group.key === "wishlist" && (
                            <Badge variant={REQUEST_TYPE[request.type].variant}>
                              {REQUEST_TYPE[request.type].label}
                            </Badge>
                          )}
                          <Badge variant={REQUEST_STATUS[request.status].variant}>
                            {REQUEST_STATUS[request.status].label}
                          </Badge>
                          {formatDate(request.submittedDate)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
