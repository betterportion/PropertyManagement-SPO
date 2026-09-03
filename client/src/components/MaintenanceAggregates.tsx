import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Repeat, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadingState } from "@/components/states";
import { formatDate } from "@/lib/format";
import type { MaintenanceContact } from "@shared/schema";

/**
 * What keeps going wrong, and who keeps being called back.
 *
 * The stated purpose is bringing evidence into a conversation with a mission
 * leader about whether to keep renting a house or keep using a contractor. The
 * filters on the maintenance list answer "what happened here?"; these answer
 * "what keeps happening here?", which is the question that settles an argument.
 *
 * Computed server-side over the caller's own visible requests, so a rollup can
 * never widen what somebody can see.
 */

interface RecurringIssue {
  buildingAddress: string;
  location: string;
  category: string;
  count: number;
  lastSeen: string | null;
}

interface ContractorLoad {
  contactId: string;
  total: number;
  open: number;
  callbacks: number;
}

export default function MaintenanceAggregates() {
  const { data, isLoading } = useQuery<{
    recurringIssues: RecurringIssue[];
    contractorLoad: ContractorLoad[];
  }>({
    queryKey: ["/api/maintenance-aggregates"],
  });

  const { data: contacts = [] } = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
  });

  const contactName = (id: string) => {
    const contact = contacts.find((candidate) => candidate.id === id);
    return contact ? `${contact.company} — ${contact.name}` : "A contractor no longer on file";
  };

  if (isLoading) return <LoadingState message="Working out what keeps happening..." />;

  const issues = data?.recurringIssues ?? [];
  const load = data?.contractorLoad ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Repeat className="h-5 w-5 text-muted-foreground" />
            What keeps going wrong
          </CardTitle>
        </CardHeader>
        <CardContent>
          {issues.length === 0 ? (
            <EmptyState
              title="Nothing has come back twice"
              description="Once the same room and kind of problem is reported more than once in a house, it appears here — with how many times and when it was last seen."
            />
          ) : (
            <ul className="divide-y divide-border">
              {issues.map((issue) => (
                <li
                  key={`${issue.buildingAddress}-${issue.location}-${issue.category}`}
                  className="flex items-start gap-3 py-3"
                  data-testid={`row-recurring-${issue.location}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {issue.location} — {issue.category}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {issue.buildingAddress}
                      {issue.lastSeen ? ` · last reported ${formatDate(issue.lastSeen)}` : ""}
                    </span>
                  </span>
                  <Badge variant={issue.count >= 3 ? "destructive" : "warning"}>
                    {issue.count} times
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
            Contractor workload
          </CardTitle>
        </CardHeader>
        <CardContent>
          {load.length === 0 ? (
            <EmptyState
              title="No contractor is linked to a request yet"
              description="Link a contractor to a maintenance request and their workload — and any callbacks to the same problem — collects here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {load.map((row) => (
                <li
                  key={row.contactId}
                  className="flex items-start gap-3 py-3"
                  data-testid={`row-contractor-load-${row.contactId}`}
                >
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/contacts/${row.contactId}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {contactName(row.contactId)}
                    </Link>
                    <span className="block text-sm text-muted-foreground">
                      {row.total} job{row.total === 1 ? "" : "s"}
                      {row.open > 0 ? ` · ${row.open} still open` : ""}
                    </span>
                  </span>
                  {/* "Called back to the same problem" is a different claim
                      from "did a lot of jobs", and it is the one that belongs
                      in a conversation about whether to keep using somebody. */}
                  {row.callbacks > 0 && (
                    <Badge variant={row.callbacks >= 2 ? "destructive" : "warning"}>
                      {row.callbacks} callback{row.callbacks === 1 ? "" : "s"}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
