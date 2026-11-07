import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/states";

interface PersonPerformance {
  name: string;
  email: string | null;
  closed: number;
  medianDaysToClose: number | null;
  usedContractor: number;
}

/**
 * Who closes maintenance work, from the close-outs. Admins only. Counts and a
 * median, never a rating (server/maintenancePerformance.ts).
 */
export default function MaintenancePerformance() {
  const { data, isLoading } = useQuery<PersonPerformance[]>({ queryKey: ["/api/maintenance-performance"] });

  return (
    <Card data-testid="card-maintenance-performance">
      <CardHeader>
        <CardTitle>Maintenance work closed</CardTitle>
        <p className="text-sm text-muted-foreground">
          Per person, the requests they marked completed, the median days from filing to completed, and how many used a
          contractor.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <LoadingState />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-maintenance-performance-none">
            Nobody has completed a request yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-maintenance-performance">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal">Person</th>
                  <th className="py-1 pr-3 text-right font-normal">Completed</th>
                  <th className="py-1 pr-3 text-right font-normal">Median days</th>
                  <th className="py-1 text-right font-normal">Used a contractor</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.map((row) => (
                  <tr key={row.email ?? row.name}>
                    <td className="py-1 pr-3">{row.name}</td>
                    <td className="py-1 pr-3 text-right">{row.closed}</td>
                    <td className="py-1 pr-3 text-right">{row.medianDaysToClose ?? "—"}</td>
                    <td className="py-1 text-right">{row.usedContractor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
