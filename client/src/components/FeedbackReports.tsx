import { useQuery } from "@tanstack/react-query";
import { Bug, ImageIcon, Lightbulb } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";
import { formatDateTime } from "@/lib/format";
import type { FeedbackReport } from "@shared/schema";

const ROLE_LABEL: Record<string, string> = { admin: "Admin", regional_administrator: "Regional admin", resident: "Household" };

/**
 * Every bug and feature report sent from the sidebar, newest first. Admins
 * only; each one was also emailed to the portal team.
 */
export default function FeedbackReports() {
  const { data, isLoading } = useQuery<FeedbackReport[]>({ queryKey: ["/api/feedback"] });

  return (
    <Card id="feedback" data-testid="card-feedback-reports">
      <CardHeader>
        <CardTitle>Bug and feature reports</CardTitle>
        <p className="text-sm text-muted-foreground">
          What people sent from "Report a problem or idea" in the sidebar. Each one is also emailed to the portal team.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <LoadingState />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-feedback-empty">No reports yet.</p>
        ) : (
          <ul className="divide-y" data-testid="list-feedback-reports">
            {data.map((r) => (
              <li key={r.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0" data-testid={`feedback-report-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={r.kind === "bug" ? "warning" : "info"} className="gap-1">
                    {r.kind === "bug" ? <Bug className="h-3 w-3" aria-hidden /> : <Lightbulb className="h-3 w-3" aria-hidden />}
                    {r.kind === "bug" ? "Bug" : "Idea"}
                  </Badge>
                  <span className="font-medium">{r.submittedByName ?? r.submittedByEmail ?? "Unknown"}</span>
                  <span className="text-muted-foreground">
                    {[ROLE_LABEL[r.role] ?? r.role, r.houseAddress ?? r.regions].filter(Boolean).join(" · ")}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{r.message}</p>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {r.pagePath && <span>Page: {r.pagePath}</span>}
                  {r.screenshotUrl && (
                    <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
                      <ImageIcon className="h-3 w-3" aria-hidden /> Screenshot
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
