import { ExternalLink, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/states";
import { formatCurrency } from "@/lib/format";
import { formatTargetPeriod, type MaintenanceRequest } from "@shared/schema";

/**
 * The project fields on a project or capital project: the signed contract,
 * the two costs and the target period.
 *
 * Shown to staff only, and only on the two types that carry them -- the
 * request page decides that, and the server refuses the fields on a repair
 * regardless. Editing happens in the request's edit dialog, so this card
 * only reads. The contract is a link to where the signed agreement lives,
 * never a copy: the copy that matters is the one with the signature on it.
 */

interface RequestProjectCardProps {
  request: MaintenanceRequest;
  canEdit: boolean;
  onEdit: () => void;
}

function Fact({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function RequestProjectCard({ request, canEdit, onEdit }: RequestProjectCardProps) {
  const period = formatTargetPeriod(request.targetYear, request.targetQuarter);
  const isEmpty =
    !request.contractUrl && request.estimatedCost == null && request.actualCost == null && period === null;

  return (
    <Card data-testid="request-project-card">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <CardTitle>Project</CardTitle>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} data-testid="button-edit-project-fields">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <EmptyState
            title="No project details yet"
            description={
              canEdit
                ? "Add the signed contract link, the estimated and actual cost, and when it is meant to happen from Edit."
                : "The contract link, costs and target period will show here once the property team records them."
            }
          />
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact
              label="Signed contract"
              testId="text-project-contract"
              value={
                request.contractUrl ? (
                  <a
                    href={request.contractUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                    data-testid="link-project-contract"
                  >
                    Open the contract
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "Not linked"
                )
              }
            />
            <Fact label="Estimated cost" testId="text-project-estimated-cost" value={formatCurrency(request.estimatedCost)} />
            <Fact label="Actual cost" testId="text-project-actual-cost" value={formatCurrency(request.actualCost)} />
            <Fact label="Target period" testId="text-project-target-period" value={period ?? "Not set"} />
          </dl>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          The contract is a link to where the signed agreement lives, on Drive or Adobe; the portal never holds a copy.
          Costs are amounts only. The money moves in QuickBooks and Ramp.
        </p>
      </CardContent>
    </Card>
  );
}
